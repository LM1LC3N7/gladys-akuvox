# Akuvox for Gladys

**Unofficial integration, not affiliated with Akuvox**, for the Akuvox door phones and access controllers
(E, R, X and A series: E12, E18, R20, R29, X915, X916, A05…) on your local network, through their **HTTP
API**, without the Akuvox cloud. **Never tested with a real device**: built from the pylocal-akuvox 1.7.0
library and the "Local Akuvox" Home Assistant integration 1.0.5. Your feedback is welcome.

## What it does

- **State of the door relays** (relays A to D): "locked" at rest, "unlocked" while the relay is
  released. Read only.
- **An "Open relay" button** per relay, **off by default**: check "Allow opening the doors from Gladys".
  It is a push button, never a switch: a "turn everything off" or "lock everything" never opens a door.
- **Scene triggers**:
  - "Akuvox door opened": a granted access in the door log (code, card, face, app…), with the relay, the
    method and the user name;
  - "Akuvox access denied": a refused access (wrong code, unknown card…);
  - "Akuvox call": a new call in the call log (dialed, received, missed), with the name of the other
    party. A visitor ringing makes a **dialed** call on a door phone.

The PIN or card number of the log is never read nor published.

## Prepare the device

In the web page of each device (its IP address in a browser):

1. **Settings → HTTP API**: enable the API, choose **Digest** (recommended) or Basic authentication, and
   create a user and a password. "None" or an allowlist of addresses works too: then add the address of
   Gladys to the list.
2. Give the device a **fixed IP address** in your router.
3. The relays must be in **automatic** mode (close after a delay), the default. A relay in manual
   (bistable) mode, or whose mode cannot be read, is never opened by the integration.

## Configuration

- **Addresses of the devices**: separated by commas, 8 at most, with `:port` if the web page is not on
  port 80. The same user and password serve for all.
- **Authentication**: as on the devices. With **Digest**, the password never travels on the network; with
  **Basic**, it travels in clear on your local network at every request. If a device asks for Basic while
  Digest is chosen, nothing is sent and the status says so.
- **Reading interval**: 5 to 300 s (10 s by default). The devices push nothing: an opening or a call shows
  within this time.
- **Opening duration**: 1 to 30 s (5 s by default). The relay closes by itself after it, whatever happens
  to Gladys: the device closes it.

The **Test the connection** button reads the identity of each device (at most once every 5 s per device).

## Safety of the opening

- Off by default; the option is read again right before sending: unchecked while an opening waits for the
  device, nothing leaves.
- Right before each opening, the integration reads the identity of the device again (its MAC address): if
  another device answers at this address, nothing is sent. It also reads the relay configuration again:
  only a relay in automatic mode, of a known type, is opened.
- An opening is **never sent again** by the integration, never retried, never replayed after a restart.
- An opening goes before the readings: a slow reading is dropped, never waited for.
- The result is in the status: "opened, confirmed" only when the relay, at rest before, is read released
  after it; otherwise "accepted by the device, not read back yet", "sent, no answer (maybe opened)",
  "refused by the device" or "nothing sent" with the reason.
- There is no closing command: the relay closes by itself (automatic mode of the API).

Refusals of an opening before anything is sent: option unchecked, credentials refused, device unknown or
not read yet, another device at the address, identity unreadable, access refused by the device (403),
Basic asked while Digest is chosen, device unreachable, relay configuration unreadable or not allowed,
relay mode unreadable, relay in manual mode, relay not on the device, too many commands waiting (4 per device), the
3.3 s deadline passed before sending, integration stopped or reconfigured.

## Refused credentials

A device that refuses the user or the password is not asked again (some lock their API after a few
failures): the status says so, and it holds across a restart. The integration tries again as soon as you
change the credentials, save the configuration or click "Test the connection" (one try each time). A 403
(address not allowed) is not a credentials refusal: it is tried again after 1 minute, then 2, 4… up to one
hour. A 401 or 403 on a log or on the configuration only does not count either: that reading is set aside
(same spacing), the status says so, and the relays are still read.

## Events: what to know

- A log entry becomes an event only if it appears **between two close readings**: at start, after an
  outage of the device longer than 2 minutes (or 3 intervals), or when the log was cleared, the entries
  already there are not published. The time of the log is the device's own, which the integration cannot
  compare with its clock: it publishes nothing stale.
- The entry an opening from Gladys leaves in the log is not a "door opened" event (a scene opening the
  door on that event would loop), whatever the interval: the mark lives until two readings of the log after
  the opening (30 minutes at most). An entry with a code, a card, a face… is never taken for it: someone at
  the door is always published.
- At most 5 new entries per log and per reading (the newest), 200 events per minute.
- The log read is the first page the device returns: if your model returns the oldest first, say so in the
  forum topic.

## Known limits

- A device without the configuration API (`/api/config/get`), or whose API user cannot read it, never
  opens: the mode of its relays cannot be checked. The status and the answer to the command say so. The
  same goes if the device takes more than 1.5 s to send it.
- Not supported yet: HTTPS, indoor monitors (IT83, opening through `/fcgi/do`), relays in manual mode,
  events pushed by the device (Action URL).
- Personal data: the user name of an access goes to your Gladys scenes, nowhere else, never into the
  integration logs.

## Help

Gladys forum (topic of the integration) or the GitHub issues of `LM1LC3N7/gladys-akuvox`.
