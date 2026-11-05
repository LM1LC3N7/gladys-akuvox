# Third-party notices

This integration ports to JavaScript the local HTTP API of the Akuvox door
phones and access controllers as implemented by the following projects: the
endpoints (`/api/system/info`, `/api/relay/status`, `/api/relay/trig`,
`/api/config/get`, `/api/doorlog/get`, `/api/calllog/get`), the answer
envelope (`retcode`, `message`, `data`, the "api unsupported" markers), the
relay trigger body (`num`, `mode`, `level`, `delay`), the relay configuration
keys (`Config.DoorSetting.RELAY.*`), the reading of the relay states (strings,
or integers by relay type) and the log entries. No file is copied, and nothing
of them is installed at runtime.

## pylocal-akuvox

<https://github.com/tykeal/pylocal-akuvox>, version 1.7.0 (commit 7b5e095)

```
SPDX-FileCopyrightText: 2026 Andrew Grimberg <tykeal@bardicgrove.org>
SPDX-License-Identifier: Apache-2.0

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## homeassistant-local-akuvox

<https://github.com/tykeal/homeassistant-local-akuvox>, version 1.0.5 (commit
d9b6609): the reading of integer relay states by relay type, and the default
relay type when the configuration cannot be read.

```
SPDX-FileCopyrightText: 2026 Andrew Grimberg <tykeal@bardicgrove.org>
SPDX-License-Identifier: Apache-2.0
```

Same Apache License 2.0 terms as above.

The full text of the Apache License 2.0 is the `LICENSE` file of this
repository. Changes: rewritten in JavaScript for Node.js; one request at a
time per device, every answer bounded in size and time; Digest authentication
written against RFC 7616; relay openings in automatic-close mode only.
