'use strict';

// Fixed output slots occur at n / outputRate. Idle slots are discarded.
// At simultaneous events a departure precedes an arrival, freeing buffer space.
const TIME_EPSILON = 1e-10;
const MAX_VISUAL_EVENTS = 160;

function validateConfiguration(config) {
  for (const [key, maximum] of Object.entries({arrival:500, output:500, tokenRate:500, buffer:1000, tokenCapacity:1000, duration:600})) {
    if (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] > maximum) {
      throw new RangeError(`${key} must be positive and no greater than ${maximum}.`);
    }
  }
  if (!Number.isInteger(config.buffer) || !Number.isInteger(config.tokenCapacity)) {
    throw new RangeError('Buffer and token capacities must be whole numbers.');
  }
  if (!['queue', 'drop'].includes(config.policy)) throw new RangeError('Choose a valid buffering policy.');
}

class LeakyBucket {
  constructor(capacity, outputRate) {
    this.capacity = capacity;
    this.outputRate = outputRate;
    this.queue = []; // Actual FIFO of packet objects, oldest packet at index zero.
    this.sent = 0;
    this.dropped = 0;
    this.delay = 0;
    this.outputSlot = 1;
    this.events = [];
    this.recentDrops = [];
    this.history = []; // Per-packet arrival, transmission, or drop timestamps.
  }
  get nextTransmissionTime() { return this.outputSlot / this.outputRate; }
  recordEvent(type, packet, time) {
    this.events.push({ type, id: packet.id, time });
    if (this.events.length > MAX_VISUAL_EVENTS) this.events.shift();
  }
  enqueuePacket(incoming) {
    const packet = { ...incoming, transmissionTime: null, dropTime: null };
    this.history.push(packet);
    if (this.queue.length < this.capacity) {
      this.queue.push(packet);
      this.recordEvent('arrival', packet, packet.arrivalTime);
    } else {
      packet.dropTime = packet.arrivalTime;
      this.dropped++;
      this.recentDrops.push(packet);
      if (this.recentDrops.length > 5) this.recentDrops.shift();
      this.recordEvent('drop', packet, packet.arrivalTime);
    }
  }
  transmitNextPacket(time) {
    this.outputSlot++;
    if (!this.queue.length) return;
    const packet = this.queue.shift();
    packet.transmissionTime = time;
    this.sent++;
    this.delay += time - packet.arrivalTime;
    this.recordEvent('departure', packet, time);
  }
}

// Continuous token credits retain fractional progress. One whole token sends
// one packet; output-rate slots belong only to Leaky Bucket.
class TokenBucket {
  constructor(capacity, generationRate, queueCapacity, policy) {
    this.capacity = capacity;
    this.generationRate = generationRate;
    this.queueCapacity = queueCapacity;
    this.policy = policy;
    this.generatedCredits = 0;
    this.tokens = capacity; // Start full: an initial burst is permitted.
    this.time = 0;
    this.queue = [];
    this.received = 0;
    this.sent = 0;
    this.dropped = 0;
    this.delay = 0;
    this.history = [];
    this.events = [];
    this.recentDrops = [];
  }
  get nextGenerationTime() {
    if (this.tokens >= this.capacity) return Infinity;
    const nextWholeToken = Math.min(this.capacity, Math.floor(this.tokens) + 1);
    return this.time + (nextWholeToken - this.tokens) / this.generationRate;
  }
  recordEvent(type, time, packet = null) {
    this.events.push({ type, time, id: packet?.id });
    if (this.events.length > MAX_VISUAL_EVENTS) this.events.shift();
  }
  refillTokensTo(time) {
    const before = Math.floor(this.tokens);
    const previousBalance = this.tokens;
    this.tokens = Math.min(this.capacity,
      this.tokens + Math.max(0, time - this.time) * this.generationRate);
    // Snap only floating-point residue at whole-token event boundaries.
    const rounded = Math.round(this.tokens);
    if (Math.abs(this.tokens - rounded) < TIME_EPSILON) this.tokens = rounded;
    this.generatedCredits += this.tokens - previousBalance;
    this.time = time;
    if (Math.floor(this.tokens) > before) this.recordEvent('generation', time);
  }
  transmitPacket(packet) {
    this.tokens = Math.max(0, this.tokens - 1);
    packet.transmissionTime = this.time;
    this.sent++;
    this.delay += this.time - packet.arrivalTime;
    this.recordEvent('consumption', this.time, packet);
    this.recordEvent('departure', this.time, packet);
  }
  processWaitingPackets() {
    while (this.queue.length && this.tokens >= 1) {
      this.transmitPacket(this.queue.shift());
    }
  }
  advanceTo(target) {
    // Process token boundaries in chronological order even after a long frame.
    // Existing FIFO packets take priority over simultaneous new arrivals.
    while (this.nextGenerationTime <= target + TIME_EPSILON) {
      this.refillTokensTo(this.nextGenerationTime);
      this.processWaitingPackets();
    }
    this.refillTokensTo(Math.max(this.time, target));
    this.processWaitingPackets();
  }
  receivePacket(incoming) {
    this.advanceTo(incoming.arrivalTime);
    const packet = { ...incoming, transmissionTime: null, dropTime: null };
    this.received++;
    this.history.push(packet);
    this.recordEvent('arrival', this.time, packet);
    if (!this.queue.length && this.tokens >= 1) {
      this.transmitPacket(packet);
    } else if (this.policy === 'queue' && this.queue.length < this.queueCapacity) {
      this.queue.push(packet);
    } else {
      packet.dropTime = this.time;
      this.dropped++;
      this.recentDrops.push(packet);
      if (this.recentDrops.length > 5) this.recentDrops.shift();
      this.recordEvent('drop', this.time, packet);
    }
  }
}

class TrafficSimulation {
  constructor(config) {
    validateConfiguration(config);
    this.config = { ...config };
    this.time = 0;
    this.received = 0;
    this.arrivalIndex = 1;
    this.queueArea = { leaky: 0, token: 0 };
    this.leaky = new LeakyBucket(config.buffer, config.output);
    this.token = new TokenBucket(config.tokenCapacity, config.tokenRate,
      config.buffer, config.policy);
  }
  get tokens() { return this.token.tokens; }
  generateIncomingPacket(time) {
    // One event object supplies identical IDs and timestamps to both algorithms.
    const packet = { id: ++this.received, arrivalTime: time };
    this.arrivalIndex++;
    this.leaky.enqueuePacket(packet);
    this.token.receivePacket(packet);
  }
  integrateQueueOccupancy(target) {
    const dt = Math.max(0, target - this.time);
    for (const name of ['leaky', 'token']) this.queueArea[name] += this[name].queue.length * dt;
  }
  step(dt) {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Elapsed time must be finite and nonnegative.');
    const target = Math.min(this.config.duration, this.time + dt);
    while (true) {
      const arrival = this.arrivalIndex / this.config.arrival;
      const departure = this.leaky.nextTransmissionTime;
      const next = Math.min(arrival, departure, this.token.nextGenerationTime);
      if (next > target + TIME_EPSILON) break;
      this.integrateQueueOccupancy(next);
      this.token.advanceTo(next);
      if (departure <= next + TIME_EPSILON) this.leaky.transmitNextPacket(departure);
      if (arrival <= next + TIME_EPSILON) this.generateIncomingPacket(arrival);
      this.time = next;
    }
    this.integrateQueueOccupancy(target);
    this.token.advanceTo(target);
    this.time = target;
    for (const bucket of [this.leaky, this.token]) {
      bucket.events = bucket.events.filter(event => target - event.time < 0.7);
    }
  }
}

// All cards, graphs, and the conclusion use this one event-derived snapshot.
function comparisonMetrics(simulation) {
  const result = {};
  for (const name of ['leaky', 'token']) {
    const bucket = simulation[name];
    result[name] = {
      received: simulation.received, sent: bucket.sent, dropped: bucket.dropped,
      waiting: bucket.sent ? bucket.delay / bucket.sent * 1000 : null,
      throughput: simulation.time ? bucket.sent / simulation.time : 0,
      queued: bucket.queue.length,
      queueUtilisation: bucket.queue.length / simulation.config.buffer * 100,
      averageQueueUtilisation: simulation.time ? simulation.queueArea[name] / (simulation.time * simulation.config.buffer) * 100 : 0
    };
  }
  const supplied = simulation.token.capacity + simulation.token.generatedCredits;
  result.token.tokenUtilisation = supplied ? simulation.token.sent / supplied * 100 : 0;
  return result;
}

function generateConclusion(simulation) {
  const metrics = comparisonMetrics(simulation), l = metrics.leaky, t = metrics.token;
  if (!simulation.received) return {
    title: 'No packets arrived during this run',
    text: `The ${simulation.time.toFixed(2)}s duration ended before the first arrival at ${(1 / simulation.config.arrival).toFixed(2)}s. Increase the duration or arrival rate to compare the algorithms.`
  };
  const label = name => name === 'leaky' ? 'Leaky Bucket' : 'Token Bucket';
  const deliveryLeader = l.sent === t.sent ? null : l.sent > t.sent ? 'leaky' : 'token';
  const lossLeader = l.dropped === t.dropped ? null : l.dropped < t.dropped ? 'leaky' : 'token';
  const waitLeader = l.waiting !== null && t.waiting !== null && Math.abs(l.waiting - t.waiting) > 1e-6
    ? l.waiting < t.waiting ? 'leaky' : 'token' : null;
  // State the ranking criterion explicitly; do not hide tradeoffs in a score.
  const leader = deliveryLeader || lossLeader || waitLeader;
  const criterion = deliveryLeader ? 'delivery' : lossLeader ? 'packet retention' : 'waiting time';
  const title = leader ? `${label(leader)} led on ${criterion}` : 'Both algorithms matched on measured outcomes';
  const wait = value => value === null ? 'no transmitted packets' : `${value.toFixed(2)} ms average wait`;
  let text = `Of ${simulation.received} shared arrivals over ${simulation.time.toFixed(2)}s, Leaky Bucket transmitted ${l.sent}, dropped ${l.dropped}, and achieved ${l.throughput.toFixed(3)} pkt/s with ${wait(l.waiting)}. Token Bucket transmitted ${t.sent}, dropped ${t.dropped}, and achieved ${t.throughput.toFixed(3)} pkt/s with ${wait(t.waiting)}.`;
  if (leader) {
    const tradeoffs = [lossLeader, waitLeader].filter(name => name && name !== leader);
    if (tradeoffs.length) text += ' The other algorithm performed better on ' + [lossLeader && lossLeader !== leader ? 'packet loss' : '', waitLeader && waitLeader !== leader ? 'waiting time' : ''].filter(Boolean).join(' and ') + '; there is no single winner across every metric.';
  }
  text += ` At the cutoff, ${l.queued} and ${t.queued} packets respectively remained queued; these are pending, not drops. Waiting averages include transmitted packets only.`;
  text += ` The run used ${simulation.config.output} pkt/s Leaky Bucket output and ${simulation.config.tokenRate} tokens/s generation with ${simulation.config.tokenCapacity} initial tokens. Token Bucket can spend accumulated tokens in bursts; its output has no separate fixed-rate limit.`;
  return {title, text};
}

const $ = id => document.getElementById(id);
const form = $('config-form');
let engine, state = 'ready', animationId, lastFrame = 0;
let lastSample = 0;
const charts = [];
const CHART_METRICS = [
  { id: 'transmitted-chart', key: 'sent', unit: 'packets' },
  { id: 'dropped-chart', key: 'dropped', unit: 'packets' },
  { id: 'waiting-chart', key: 'waiting', unit: 'ms' },
  { id: 'throughput-chart', key: 'throughput', unit: 'pkt/s' }
];

function configuration() {
  const values = Object.fromEntries(new FormData(form));
  for (const key of Object.keys(values)) if (key !== 'policy') values[key] = Number(values[key]);
  return values;
}

function setState(next) {
  state = next;
  $('status').textContent = { ready: 'Ready to simulate', running: 'Simulation running', paused: 'Simulation paused', complete: 'Simulation complete' }[state];
  $('status-dot').classList.toggle('running', state === 'running');
  document.body.classList.toggle('is-running', state === 'running');
  $('start').disabled = state === 'running' || state === 'paused';
  $('pause').disabled = state !== 'running';
  $('resume').disabled = state !== 'paused';
  for (const input of form.querySelectorAll('input, select')) input.disabled = state !== 'ready';
  if (state === 'complete') {
    const conclusion = generateConclusion(engine);
    $('conclusion-title').textContent = conclusion.title;
    $('conclusion-text').textContent = conclusion.text;
    $('conclusion').hidden = false;
  }
  // After completion, Start runs the same configuration again; Reset unlocks editing.
}

function render() {
  const c = engine.config;
  $('elapsed').textContent = engine.time.toFixed(1);
  $('total-duration').textContent = c.duration;
  $('run-progress').style.width = `${engine.time / c.duration * 100}%`;
  document.querySelectorAll('.arrival-value').forEach(el => el.textContent = `${c.arrival} pkt/s`);
  $('leaky-capacity').textContent = c.buffer;
  $('token-capacity-label').textContent = c.tokenCapacity;
  $('leaky-output-rate').textContent = `${c.output} pkt/s`;
  $('token-rate-label').textContent = `${c.tokenRate} tokens/s`;
  $('leaky-queued').textContent = engine.leaky.queue.length;
  $('token-available').textContent = Math.max(0, Math.floor(engine.tokens + 1e-9));
  $('leaky-fill').style.height = `${engine.leaky.queue.length / c.buffer * 100}%`;
  $('token-fill').style.height = `${Math.max(0, engine.tokens) / c.tokenCapacity * 100}%`;
  renderBucketPackets('leaky');
  renderBucketPackets('token');
  renderTokenIndicators();
  const metrics = comparisonMetrics(engine);
  for (const name of ['leaky', 'token']) {
    const bucket = engine[name];
    const m = metrics[name];
    $(name + '-card-sent').textContent = m.sent;
    $(name + '-card-dropped').textContent = m.dropped;
    $(name + '-card-waiting').textContent = m.waiting === null ? '—' : m.waiting.toFixed(2);
    $(name + '-queue-utilisation').textContent = m.queueUtilisation.toFixed(1) + '%';
    $(name + '-average-queue').textContent = m.averageQueueUtilisation.toFixed(1) + '% time average';
    $(name + '-queue-meter').style.width = m.queueUtilisation + '%';
    $(name + '-sent').textContent = bucket.sent;
    $(name + '-dropped').textContent = bucket.dropped;
    $(name + '-delay').textContent = bucket.sent ? Math.round(bucket.delay / bucket.sent * 1000) : '—';
    $(name + '-received').textContent = engine.received;
    $(name + '-throughput').textContent = engine.time ? (bucket.sent / engine.time).toFixed(2) : '0.00';
    $(name + '-loss').textContent = (engine.received ? bucket.dropped / engine.received * 100 : 0).toFixed(1) + '%';
    $(name + '-occupancy').textContent = `${bucket.queue.length} / ${c.buffer}`;
  }
  $('token-utilisation').textContent = metrics.token.tokenUtilisation.toFixed(1) + '%';
  $('token-utilisation-meter').style.width = metrics.token.tokenUtilisation + '%';
}

// Animation positions use simulation time, so Pause freezes every packet.
function renderBucketPackets(name) {
  const bucket = engine[name];
  const capacity = name === 'token' ? bucket.queueCapacity : bucket.capacity;
  const visible = bucket.queue.slice(0, 24);
  $(name + '-packet-queue').replaceChildren(...visible.map(packet => {
    const node = document.createElement('span');
    node.className = 'queued-packet';
    node.textContent = '#' + packet.id;
    // A subtle waiting pulse follows simulation time and freezes on Pause.
    node.style.opacity = 0.8 + 0.2 * Math.sin((engine.time - packet.arrivalTime) * 3);
    node.title = `Packet #${packet.id} · arrived ${packet.arrivalTime.toFixed(4)}s`;
    return node;
  }));
  $(name + '-queue-summary').textContent = bucket.queue.length
    ? `FIFO: oldest first · ${bucket.queue.length} / ${capacity} packets${bucket.queue.length > 24 ? ' · showing first 24' : ''}`
    : `Buffer empty · 0 / ${capacity} packets`;
  $(name + '-packet-events').replaceChildren(...bucket.events.filter(event => ['arrival', 'departure', 'drop'].includes(event.type)).slice(-40).map(event => {
    const node = document.createElement('span');
    const progress = Math.min(1, (engine.time - event.time) / 0.7);
    node.className = 'moving-packet ' + event.type;
    node.textContent = '#' + event.id;
    node.style.transform = `translateY(${(event.type === 'arrival' ? progress - 1 : progress) * 34}px)`;
    node.style.opacity = 1 - progress;
    return node;
  }));
  $(name + '-drop-history').textContent = bucket.recentDrops.map(packet => `#${packet.id} at ${packet.dropTime.toFixed(3)}s`).join(' · ') || 'No packets dropped';
}

function renderTokenIndicators() {
  const bucket = engine.token;
  const wholeTokens = Math.floor(bucket.tokens);
  // Cap DOM indicators for large buckets; the numeric balance remains exact.
  $('token-indicators').replaceChildren(...Array.from({ length: Math.min(wholeTokens, 40) }, () => {
    const node = document.createElement('i');
    node.className = 'token-indicator';
    return node;
  }));
  $('token-balance').textContent = `${bucket.tokens.toFixed(3)} / ${bucket.capacity} tokens${wholeTokens > 40 ? ' · showing 40' : ''}`;
  $('token-policy-label').textContent = bucket.policy === 'queue' ? 'Wait in finite FIFO queue' : 'Drop immediately without a token';
  $('token-credit-events').replaceChildren(...bucket.events
    .filter(event => event.type === 'generation' || event.type === 'consumption').slice(-12).map(event => {
      const node = document.createElement('span');
      const progress = Math.min(1, (engine.time - event.time) / 0.7);
      node.className = 'credit-event ' + event.type;
      node.textContent = event.type === 'generation' ? '+1 token' : `−1 · #${event.id}`;
      node.style.opacity = 1 - progress;
      node.style.transform = `translateY(${-progress * 15}px)`;
      return node;
    }));
}

function initCharts() {
  if (typeof Chart === 'undefined') {
    $('chart-message').hidden = false;
    return;
  }
  for (const {id, unit} of CHART_METRICS) {
    charts.push(new Chart($(id), {
      type: 'line',
      data: { labels: [0], datasets: ['Leaky Bucket', 'Token Bucket'].map((label, i) => ({
        label, data: [id === 'waiting-chart' ? null : 0], borderColor: i ? '#34d4bb' : '#5e91ff',
        backgroundColor: i ? '#34d4bb0a' : '#5e91ff0a', borderWidth: 2,
        pointRadius: 0, pointHitRadius: 12, tension: 0, fill: true
      })) },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => `${items[0].label}s` } } },
        scales: {
          x: { type: 'linear', min: 0, grid: { display: false }, title: { display: true, text: 'Time (s)', color: '#7489a7', font: { size: 9 } }, ticks: { color: '#7489a7', maxTicksLimit: 7, maxRotation: 0, font: { size: 9 } }, border: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: unit, color: '#7489a7', font: { size: 9 } }, suggestedMax: 1, ticks: { color: '#7489a7', maxTicksLimit: 5, precision: 0, font: { size: 9 } }, grid: { color: '#24314766' }, border: { display: false } }
        }
      }
    }));
  }
}

function sample() {
  if (engine.time <= lastSample) return;
  const metrics = comparisonMetrics(engine);
  charts.forEach((chart, index) => {
    chart.data.labels.push(Number(engine.time.toFixed(6)));
    chart.data.datasets.forEach((dataset, i) => dataset.data.push(metrics[i ? 'token' : 'leaky'][CHART_METRICS[index].key]));
    chart.update('none');
  });
  lastSample = engine.time;
}

function initialize(config = configuration(), prepareOnly = state === 'ready') {
  // Invalid partially edited inputs must never create a broken simulation.
  if (prepareOnly && !form.checkValidity()) return;
  cancelAnimationFrame(animationId);
  animationId = null;
  engine = new TrafficSimulation(config);
  // Reset clears the preview. Start explicitly creates a full initial bucket.
  if (prepareOnly) engine.token.tokens = 0;
  lastSample = 0;
  charts.forEach((chart, i) => {
    chart.data.labels = [0];
    chart.data.datasets.forEach(dataset => dataset.data = [CHART_METRICS[i].key === 'waiting' ? null : 0]);
    chart.options.scales.y.suggestedMax = CHART_METRICS[i].key === 'throughput' ? Math.max(config.arrival, config.output, config.tokenRate) : 1;
    chart.update('none');
  });
  $('conclusion').hidden = true;
  $('conclusion-title').textContent = '';
  $('conclusion-text').textContent = '';
  render();
}

// Only active wall-clock intervals advance the shared simulation clock.
// Stop at each integer-second chart boundary for consistent sample timestamps.
function advanceClock(timestamp) {
  const target = Math.min(engine.config.duration, engine.time + Math.max(0, timestamp - lastFrame) / 1000);
  lastFrame = timestamp;
  while (engine.time < target) {
    const boundary = Math.min(target, lastSample + 1);
    engine.step(boundary - engine.time);
    if (engine.time >= lastSample + 1 - TIME_EPSILON) sample();
  }
  render();
  if (engine.time >= engine.config.duration) {
    sample();
    setState('complete');
  }
}
function frame(timestamp) {
  animationId = null; // The callback has been consumed; only one may be pending.
  if (state !== 'running') return;
  advanceClock(timestamp);
  if (state === 'running') animationId = requestAnimationFrame(frame);
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (state === 'running' || state === 'paused' || !form.reportValidity()) return;
  // Disabled inputs are omitted by FormData; preserve the finished run's config.
  initialize(state === 'complete' ? engine.config : configuration(), false);
  setState('running');
  lastFrame = performance.now();
  animationId = requestAnimationFrame(frame);
});
$('pause').addEventListener('click', () => {
  if (state !== 'running') return;
  cancelAnimationFrame(animationId);
  animationId = null;
  advanceClock(performance.now());
  if (state !== 'complete') setState('paused');
});
$('resume').addEventListener('click', () => { if (state !== 'paused') return; setState('running'); lastFrame = performance.now(); animationId = requestAnimationFrame(frame); });
$('reset').addEventListener('click', () => {
  setState('ready');
  // Restore the last valid settings if Reset is clicked midway through an edit.
  if (!form.checkValidity()) {
    for (const input of form.querySelectorAll('input, select')) input.value = engine.config[input.name];
  }
  initialize();
});
form.addEventListener('input', () => { if (state === 'ready' && form.checkValidity()) initialize(); });
initCharts();
initialize();
setState('ready');
