# Simulated benchmark

In-memory MCP transport, simulated terminal and screenshot providers, memory worker/task/event storage. File telemetry enabled in paired runs; no model calls. Lifecycle scenarios reset with a fresh fixture each iteration. Timings include real configured paste delays. Push scenario measures disabling, not hook delivery.

Node v22.14.0; 5 warm-ups and 30 measured iterations per mode. Commit 62bbd97740c42117a26e8f41ebf3321ba7fec7cc (modified).

| Tool | Off median ms | On median ms | On p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|---:|
| agent.adopt | 0.150 | 0.159 | 0.303 | 296 | 2 |
| agent.broadcast | 101.286 | 101.304 | 102.456 | 282 | 10 |
| agent.collect_results | 0.344 | 0.368 | 0.757 | 3427 | 8 |
| agent.forget | 0.392 | 0.367 | 0.575 | 59 | 0 |
| agent.interrupt | 0.496 | 0.523 | 0.669 | 61 | 4 |
| agent.list | 0.095 | 0.111 | 0.284 | 717 | 2 |
| agent.observe | 0.290 | 0.295 | 0.503 | 1644 | 3 |
| agent.reattach | 0.133 | 0.167 | 0.387 | 296 | 2 |
| agent.screenshot | 0.106 | 0.115 | 0.332 | 155 | 3 |
| agent.send | 101.020 | 101.149 | 102.075 | 159 | 5 |
| agent.spawn | 0.284 | 0.276 | 0.417 | 165 | 2 |
| agent.status | 0.255 | 0.255 | 0.405 | 1650 | 3 |
| agent.stop | 0.389 | 0.358 | 0.629 | 57 | 3 |
| agent.wait_for_outcome | 1.962 | 2.043 | 2.789 | 1858 | 9 |
| agent.wait_for_text | 0.222 | 0.237 | 0.468 | 1650 | 3 |
| agent.wait_until_idle | 0.205 | 0.229 | 0.372 | 1650 | 3 |
| event.acknowledge | 0.098 | 0.106 | 0.242 | 291 | 0 |
| event.list | 0.070 | 0.086 | 0.229 | 328 | 0 |
| event.wait_for_event | 0.093 | 0.116 | 0.243 | 267 | 0 |
| event.wake_command | 0.094 | 0.103 | 0.254 | 694 | 0 |
| orchestrator.attention | 0.578 | 0.619 | 0.961 | 731 | 8 |
| orchestrator.status | 0.357 | 0.328 | 0.750 | 1609 | 8 |
| push.set | 0.070 | 0.076 | 0.155 | 132 | 1 |
| push.status | 0.034 | 0.042 | 0.066 | 144 | 0 |
| task.archive | 0.266 | 0.325 | 0.668 | 1094 | 0 |
| task.assign | 0.189 | 0.210 | 0.371 | 661 | 0 |
| task.create | 0.351 | 0.379 | 0.725 | 627 | 0 |
| task.get | 0.129 | 0.142 | 0.392 | 647 | 0 |
| task.history | 0.096 | 0.133 | 0.260 | 923 | 0 |
| task.list | 0.082 | 0.093 | 0.190 | 717 | 0 |
| task.report_result | 0.482 | 0.533 | 0.903 | 976 | 0 |
| task.start_attempt | 0.212 | 0.244 | 0.696 | 846 | 0 |
| task.update | 0.242 | 0.257 | 0.435 | 625 | 0 |
| task.verify | 0.349 | 0.439 | 0.760 | 1095 | 0 |
| terminal.close | 0.139 | 0.141 | 0.198 | 55 | 3 |
| terminal.focus | 0.101 | 0.113 | 0.190 | 52 | 2 |
| terminal.list | 0.148 | 0.261 | 0.581 | 164 | 1 |
| terminal.list_instances | 0.049 | 0.085 | 0.228 | 203 | 2 |
| terminal.move | 0.042 | 0.045 | 0.132 | 52 | 1 |
| terminal.read | 0.137 | 0.183 | 0.408 | 10241 | 1 |
| terminal.resize | 0.128 | 0.134 | 0.236 | 52 | 1 |
| terminal.screenshot | 0.050 | 0.052 | 0.244 | 155 | 2 |
| terminal.select_instance | 0.040 | 0.059 | 0.302 | 104 | 1 |
| terminal.send_key | 0.167 | 0.189 | 0.262 | 52 | 1 |
| terminal.send_keys | 0.080 | 0.088 | 0.212 | 52 | 2 |
| terminal.send_text | 0.070 | 0.076 | 0.144 | 52 | 1 |
| terminal.snapshot | 0.523 | 0.606 | 0.947 | 15980 | 13 |
| terminal.spawn | 0.062 | 0.074 | 0.210 | 40 | 1 |
| terminal.split | 0.053 | 0.066 | 0.181 | 40 | 1 |
| terminal.submit | 100.567 | 100.634 | 101.229 | 52 | 2 |
| watch.create | 0.413 | 0.443 | 0.710 | 366 | 5 |
| watch.list | 0.070 | 0.080 | 0.200 | 368 | 0 |
| watch.remove | 0.038 | 0.048 | 0.090 | 57 | 0 |

## 1 simulated workers

| Scenario | Median ms | p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|
| agent.collect_results | 0.147 | 0.226 | 1665 | 5 |
| observe.append | 0.119 | 0.253 | 909 | 3 |
| observe.full | 0.103 | 0.378 | 1582 | 3 |
| observe.unchanged | 0.102 | 0.225 | 900 | 3 |
| orchestrator.status | 0.129 | 0.548 | 827 | 5 |
| terminal.snapshot | 0.193 | 0.345 | 7767 | 8 |
| watch.poll | 0.133 | 0.388 | 14 | 5 |

## 5 simulated workers

| Scenario | Median ms | p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|
| agent.collect_results | 0.481 | 0.670 | 8437 | 17 |
| observe.append | 0.120 | 0.510 | 909 | 3 |
| observe.full | 0.109 | 0.212 | 1582 | 3 |
| observe.unchanged | 0.123 | 0.178 | 900 | 3 |
| orchestrator.status | 0.447 | 1.137 | 3975 | 17 |
| terminal.snapshot | 0.625 | 0.779 | 27067 | 24 |
| watch.poll | 0.701 | 1.627 | 14 | 25 |

## 10 simulated workers

| Scenario | Median ms | p95 ms | Max result bytes | Backend calls |
|---|---:|---:|---:|---:|
| agent.collect_results | 1.138 | 2.194 | 16904 | 32 |
| observe.append | 0.143 | 0.283 | 909 | 3 |
| observe.full | 0.141 | 0.537 | 1582 | 3 |
| observe.unchanged | 0.143 | 0.507 | 900 | 3 |
| orchestrator.status | 1.049 | 2.177 | 7912 | 32 |
| terminal.snapshot | 1.376 | 2.114 | 51198 | 44 |
| watch.poll | 1.744 | 3.226 | 14 | 50 |
