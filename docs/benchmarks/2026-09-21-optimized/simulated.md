# Simulated benchmark

In-memory MCP transport, simulated terminal and screenshot providers, memory worker/task/event storage. File telemetry enabled in paired runs; no model calls. Lifecycle scenarios reset with a fresh fixture each iteration. Timings include real configured paste delays. Push scenario measures disabling, not hook delivery.

Node v22.14.0; 5 warm-ups and 30 measured iterations per mode. Commit 536c2a2f92a01d3ebe3852c0d15c6ad1d00f012a (modified).

| Tool | Off median ms | On median ms | On p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|---:|
| agent.adopt | 0.152 | 0.189 | 0.466 | 296 | 2 |
| agent.broadcast | 101.191 | 101.267 | 102.298 | 282 | 10 |
| agent.collect_results | 0.376 | 0.341 | 0.823 | 3427 | 4 |
| agent.forget | 0.420 | 0.403 | 0.620 | 59 | 0 |
| agent.interrupt | 0.538 | 0.564 | 0.961 | 61 | 4 |
| agent.list | 0.102 | 0.130 | 0.286 | 717 | 2 |
| agent.observe | 0.289 | 0.296 | 0.621 | 1644 | 3 |
| agent.reattach | 0.133 | 0.170 | 0.332 | 296 | 2 |
| agent.screenshot | 0.128 | 0.127 | 0.305 | 155 | 3 |
| agent.send | 101.076 | 101.091 | 102.408 | 159 | 5 |
| agent.spawn | 0.271 | 0.290 | 0.741 | 165 | 2 |
| agent.status | 0.240 | 0.247 | 0.544 | 1650 | 3 |
| agent.stop | 0.359 | 0.385 | 0.688 | 57 | 3 |
| agent.wait_for_outcome | 1.898 | 1.436 | 2.803 | 1858 | 6 |
| agent.wait_for_text | 0.225 | 0.229 | 0.609 | 1650 | 3 |
| agent.wait_until_idle | 0.231 | 0.249 | 0.587 | 1650 | 3 |
| event.acknowledge | 0.100 | 0.112 | 0.175 | 291 | 0 |
| event.list | 0.077 | 0.087 | 0.123 | 328 | 0 |
| event.wait_for_event | 0.090 | 0.106 | 0.236 | 267 | 0 |
| event.wake_command | 0.098 | 0.108 | 0.163 | 694 | 0 |
| orchestrator.attention | 0.561 | 0.612 | 1.250 | 731 | 4 |
| orchestrator.status | 0.331 | 0.342 | 0.778 | 1609 | 4 |
| push.set | 0.074 | 0.074 | 0.136 | 132 | 1 |
| push.status | 0.039 | 0.042 | 0.105 | 237 | 0 |
| task.archive | 0.317 | 0.322 | 0.557 | 1094 | 0 |
| task.assign | 0.215 | 0.220 | 0.709 | 661 | 0 |
| task.create | 0.360 | 0.357 | 0.663 | 627 | 0 |
| task.get | 0.128 | 0.148 | 0.322 | 647 | 0 |
| task.history | 0.114 | 0.128 | 0.211 | 923 | 0 |
| task.list | 0.090 | 0.093 | 0.206 | 717 | 0 |
| task.report_result | 0.478 | 0.533 | 0.961 | 976 | 0 |
| task.start_attempt | 0.241 | 0.250 | 0.579 | 846 | 0 |
| task.update | 0.256 | 0.297 | 0.716 | 625 | 0 |
| task.verify | 0.363 | 0.375 | 0.639 | 1095 | 0 |
| terminal.close | 0.140 | 0.146 | 0.399 | 55 | 3 |
| terminal.focus | 0.117 | 0.117 | 0.249 | 52 | 2 |
| terminal.list | 0.156 | 0.279 | 0.551 | 164 | 1 |
| terminal.list_instances | 0.052 | 0.082 | 0.153 | 203 | 2 |
| terminal.move | 0.045 | 0.049 | 0.141 | 52 | 1 |
| terminal.read | 0.137 | 0.189 | 0.320 | 10241 | 1 |
| terminal.resize | 0.142 | 0.137 | 0.352 | 52 | 1 |
| terminal.screenshot | 0.053 | 0.058 | 0.135 | 155 | 2 |
| terminal.select_instance | 0.040 | 0.055 | 0.139 | 104 | 1 |
| terminal.send_key | 0.179 | 0.205 | 0.404 | 52 | 1 |
| terminal.send_keys | 0.086 | 0.093 | 0.267 | 52 | 2 |
| terminal.send_text | 0.065 | 0.078 | 0.240 | 52 | 1 |
| terminal.snapshot | 0.478 | 0.511 | 0.778 | 15980 | 6 |
| terminal.spawn | 0.063 | 0.074 | 0.244 | 40 | 1 |
| terminal.split | 0.053 | 0.065 | 0.151 | 40 | 1 |
| terminal.submit | 100.562 | 100.584 | 101.415 | 52 | 2 |
| watch.create | 0.351 | 0.377 | 0.490 | 366 | 3 |
| watch.list | 0.059 | 0.066 | 0.129 | 368 | 0 |
| watch.remove | 0.041 | 0.046 | 0.093 | 57 | 0 |

## 1 simulated workers

| Scenario | Median ms | p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|
| agent.collect_results | 0.116 | 0.428 | 1665 | 3 |
| observe.append | 0.106 | 0.208 | 913 | 3 |
| observe.full | 0.095 | 0.213 | 1582 | 3 |
| observe.unchanged | 0.102 | 0.198 | 900 | 3 |
| orchestrator.status | 0.109 | 0.166 | 827 | 3 |
| terminal.snapshot | 0.163 | 0.395 | 7767 | 4 |
| watch.poll | 0.102 | 0.306 | 14 | 3 |

## 5 simulated workers

| Scenario | Median ms | p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|
| agent.collect_results | 0.439 | 0.996 | 8437 | 7 |
| observe.append | 0.121 | 0.752 | 913 | 3 |
| observe.full | 0.119 | 0.198 | 1582 | 3 |
| observe.unchanged | 0.119 | 0.202 | 900 | 3 |
| orchestrator.status | 0.386 | 0.724 | 3975 | 7 |
| terminal.snapshot | 0.499 | 0.773 | 27067 | 8 |
| watch.poll | 0.451 | 1.108 | 14 | 7 |

## 10 simulated workers

| Scenario | Median ms | p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|
| agent.collect_results | 0.887 | 1.628 | 16904 | 12 |
| observe.append | 0.141 | 0.291 | 913 | 3 |
| observe.full | 0.126 | 0.278 | 1582 | 3 |
| observe.unchanged | 0.145 | 0.265 | 900 | 3 |
| orchestrator.status | 0.864 | 1.552 | 7912 | 12 |
| terminal.snapshot | 1.068 | 1.664 | 51198 | 13 |
| watch.poll | 1.049 | 1.463 | 14 | 12 |
