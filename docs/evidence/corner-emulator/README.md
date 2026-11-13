# Corner Android connection proof

Reproduction emulator-1, run on squire from corner `93bbc61e-486a-432a-a21a-dc562c3ab1f3` on 10 November 2026.

## Report and reproduction

Read the latest emulator Report Error in production feedback through the owner's sealed Neon API route: `fb_6f47ffbfee6edb455064a71e`, reported on `v0.1.200-rc.2`. It says the grant offered `emulator-5652` while the allowed ADB server said that device did not exist.

After the real corner host grant allowed access, this command reproduced the missing historical serial:

```sh
adb -H 127.0.0.1 -P 5037 -s emulator-5652 get-state
# error: device 'emulator-5652' not found
```

A fresh live grant call already omitted that serial and returned other running devices. The original enumeration/connection race could not be recreated on demand without stopping or managing host emulators, which this assignment excludes. This does not establish the exact cause of the historical report.

The closest stand-in exercises `requestGrant` against a real local ADB-protocol TCP fixture: discovery lists `emulator-5652` as `device`, then selecting that serial returns `FAIL` or `offline`. Before the change, the tool still offered that serial as allowed. The regression failed on the original code and passes after transport confirmation. Existing permission-flow tests now use this TCP fixture through approval and the subsequent discovery call, rather than a stubbed serial list. Denied and pending permission still perform no host probe.

## Demonstrated

The live corner `request_grant` call returned approved access to `127.0.0.1:5037`. After `npm run build -w @beeline/body`, the built probe confirmed these existing transports: `emulator-5626`, `emulator-5632`, `emulator-5634`, `emulator-5646`. The first transport then passed the documented connection check and a device shell read:

```text
adb -H 127.0.0.1 -P 5037 -s emulator-5626 get-state
=> device
adb -H 127.0.0.1 -P 5037 -s emulator-5626 shell getprop sys.boot_completed
=> 1
```

The built probe used the actual host ADB server, not the fixture. No emulator, ADB server, app or guest state was started, installed, stopped or changed. The historical disappearing-transport case is covered by the TCP stand-in; the real running-device path is demonstrated above. A device can still disappear after confirmation, so the result instructs the agent to repeat the grant call and use its fresh explicit host/port/serial command.

Validation: the host-emulator suite passes, Body builds and typechecks, and the no-emulator-start guard passes. Workspace typechecks passed, but root typecheck stopped at mobile because this corner lacks `@expo/router-server/build/typed-routes`; mobile typecheck could not run. The full Body suite was not run for this narrow read-only protocol change; CI selects affected tests.
