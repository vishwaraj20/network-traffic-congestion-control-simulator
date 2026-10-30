# Network Traffic Congestion Control Simulator

A Computer Networks project for advanced Computer Engineering learners. It compares Leaky Bucket and Token Bucket using the same packet arrivals and the same simulation clock. Every result comes from packet events; there are no random performance values.

## Features

- Configurable arrival rate, output rate, buffer size, token generation rate, token capacity, duration, and Token Bucket policy.
- Fractional packet and token rates.
- Start, Pause, Resume, and Reset with one animation loop.
- Animated arrivals, FIFO contents, transmissions, drops, and token generation/consumption.
- Side-by-side comparison cards and four Chart.js graphs.
- An automatic conclusion that reports delivery, loss, waiting time, and pending packets, including tradeoffs.
- Dark dashboard with responsive desktop, laptop, tablet, and phone breakpoints.
- An optional dependency-free automated audit.

## Technologies

HTML5, CSS3, and vanilla JavaScript. Chart.js 4.4.8 loads from a pinned CDN URL. No framework, backend, build step, or database is required. Node.js is only needed to run the optional tests.

## How to run

1. Keep `index.html`, `style.css`, and `script.js` together.
2. Open `index.html` in a current version of Chrome.
3. Enter parameters and press **Start simulation**.
4. Pause and resume as needed. Inputs remain locked during a run and after completion.
5. Press **Reset simulation** to clear the run and unlock the inputs. Valid settings are preserved; an unfinished invalid edit is restored to the last valid settings.

Internet access is needed for Chart.js. If its download fails, the simulator displays a message and continues with metrics and conclusions. No data is uploaded or saved.

Reset empties the preview, including token balance, packet queues, histories, transient animations, counters, chart samples, and the conclusion. A new Start creates a fresh, **initially full** token bucket, allowing an initial burst. This initial condition is deliberate and is included in token utilisation.

## Leaky Bucket

Packets arrive at `n / arrivalRate` seconds for packet numbers `n = 1, 2, ...`. The buffer is a finite FIFO array. Accepted packets join its tail; a transmission removes the oldest packet from its head. A packet arriving at a full buffer is dropped.

The model uses fixed output slots at `n / outputRate` seconds. Each nonempty slot sends one packet; empty slots are discarded rather than saved as future credit. If departure and arrival times coincide, the departure happens first. Thus a packet arriving exactly at an output slot waits for the following slot. This is a slotted traffic-shaper model, not a physical link or variable-packet-size model.

Main methods: `enqueuePacket()` accepts or drops a packet; `transmitNextPacket()` sends the FIFO head and records its transmission timestamp.

## Token Bucket

Token credit increases continuously at the configured generation rate, capped at the bucket capacity. Fractional credit is retained. Each transmitted packet spends exactly one whole token. Credit that would exceed capacity is discarded.

When credit is available, a packet transmits immediately. There is no separate fixed output-rate limit for Token Bucket, so accumulated tokens can send multiple packets at the same timestamp. With **Wait in queue**, packets without tokens join a finite FIFO, using the configured buffer capacity; overflow is dropped. With **Drop immediately**, a packet without a token is dropped and never queued. Existing waiting packets get newly available tokens before simultaneous new arrivals.

Main methods: `refillTokensTo()` adds elapsed-time credit, `advanceTo()` processes token boundaries, `receivePacket()` applies the selected policy, `processWaitingPackets()` serves the FIFO, and `transmitPacket()` spends one token and records the wait.

The dashboard offers a constant arrival stream. The automated tests also inject instantaneous packet batches to verify true bursts after an idle refill interval.

## Shared clock and controls

`TrafficSimulation.generateIncomingPacket()` creates one ID and arrival timestamp, then passes copies to both algorithms. `step()` processes events chronologically, independently of rendering speed. `advanceClock()` maps active elapsed browser time into simulation seconds, stopping at graph sample boundaries.

There is one `requestAnimationFrame` loop and no interval timers. Pause accounts for the active time since the last frame, cancels the pending callback, and freezes the simulation. Resume establishes a new wall-clock baseline, excluding the pause. A browser tab that is merely hidden is not considered paused: its next frame catches up with active elapsed time.

At the configured duration, the run stops without draining queues. Pending packets are counted separately from dropped packets. Histories are retained only for the current run; configured limits allow at most 300,000 arrivals per run. Transient visual-event buffers are capped at 160 entries per algorithm; rendering shows a smaller recent subset and the first 24 queued packet IDs. At most 40 token circles are displayed, with the full numeric balance alongside them.

## Performance metrics

| Metric | Calculation |
| --- | --- |
| Received | Shared arrival-event count |
| Transmitted | Actual packet transmission count |
| Dropped | Actual rejected-packet count |
| Current queue | Accepted packets still waiting |
| Average waiting time | Sum of `(transmissionTime - arrivalTime)` / transmitted packets, displayed in milliseconds |
| Throughput | Total transmitted / elapsed simulation seconds |
| Packet loss | Dropped / received × 100% |
| Current queue utilisation | Current queue length / buffer capacity × 100% |
| Time-average queue utilisation | Integral of queue length over time / (elapsed time × buffer capacity) × 100% |
| Token utilisation | Tokens spent / (initial token capacity + credit actually added) × 100% |

Waiting time is undefined until a packet is transmitted and is shown as a dash; its chart has a gap. Throughput is zero at time zero. Waiting averages exclude dropped and still-pending packets, so compare them together with delivery and loss. Token utilisation excludes credit discarded at capacity. It is not the percentage of time the bucket is busy.

Charts show cumulative transmitted packets, cumulative drops, average waiting time to date, and cumulative throughput. They sample each simulation second and at the final cutoff. Numeric time axes preserve proportional spacing.

The conclusion first identifies a delivery leader, then a retention leader if delivery is tied, then a waiting-time leader if both are tied. It reports opposing advantages rather than hiding them in a score. A large initially full token bucket or a higher configured rate can explain a short-run advantage; results do not establish a universally superior algorithm.

## Automated tests

From this project directory, run:

```text
node --check script.js
node tests/audit.cjs
```

The audit uses only Node.js built-in modules. It compares packet IDs, timestamps, transmissions, drops, FIFO order, and metric calculations against a separate fluid-credit reference model. It runs each traffic case under both Token Bucket policies.

Unless overridden below: duration 10 s, arrival 12 pkt/s, Leaky Bucket output 8 pkt/s, buffer 30 packets, token rate 10 tokens/s, and token capacity 20.

| Case | Overrides | Verified queue-policy result: sent / dropped / pending |
| --- | --- | --- |
| Low traffic | Arrival 2 | Leaky: 19 / 0 / 1; Token: 20 / 0 / 0 |
| High traffic / initial burst | Arrival 100 | Leaky: 80 / 890 / 30; Token: 119 / 851 / 30 |
| Small buffer | Arrival 40, buffer 1 | Leaky: 80 / 319 / 1; Token: 119 / 280 / 1 |
| Low token generation | Token rate 0.25, capacity 2 | Leaky: 80 / 10 / 30; Token: 4 / 86 / 30 |
| High token capacity | Arrival 50, token rate 0.1, capacity 1000 | Leaky: 80 / 390 / 30; Token: 500 / 0 / 0 |
| Fractional rates | Arrival 13.37, output 7.125, token rate 2.75, duration 17 | Leaky: 121 / 77 / 29; Token: 66 / 131 / 30 |

Additional verified checks:

- Immediate-drop policy never queues packets; both algorithms conserve packets: received = transmitted + dropped + pending.
- A capacity-5 bucket is drained at time 0, refills at 0.5 tokens/s until time 10, then sends five packets from a simultaneous batch immediately. Two wait and three drop; waiting packets transmit at times 12 and 14.
- Token balance remains within capacity and initial credit + generated credit = transmitted + remaining credit, within floating-point tolerance.
- Maximum workload: 500 arrivals/s for 600 s, totalling 300,000 arrivals, with bounded visual-event buffers.
- Twenty-five start/pause/resume/completion/reset cycles: no duplicate pending animation callbacks, no paused clock advance, empty queues/histories/tokens/visual nodes after Reset, cleared chart samples, and unlocked inputs.
- Invalid inputs, duplicate element IDs, chart sample values, and missing-Chart.js fallback.

These checks were executed successfully during the audit. The UI tests use a small DOM and Chart.js stub: they verify the application's handlers and datasets, not real browser drawing, layout, console output, or heap garbage collection. Responsive CSS has shrinking grid children and breakpoints at 1100, 800, and 520 pixels; this alone is not a passed visual test.

Browser audit status: Chrome's initial window was inspected, but Computer Use stopped when opening a separate audit tab because it could not determine the current browser URL confidently enough to enforce its policy. No simulator screenshot, laptop/desktop viewport check, real Chart.js rendering check, browser-console inspection, or heap profile was completed. Those items are **unverified**, not passed. Automated JavaScript syntax, algorithm, control-handler, chart-dataset, bounded-event-buffer, and single-pending-callback checks passed as described above.
