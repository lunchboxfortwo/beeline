# Shared browser keyboard stand-in

The Beeline app on the emulators is a production build. This branch is not
deployed, and the review account is not in this corner, so a share started
here does not open there.

The closest stand-in is the viewer document the phone loads. Run it from this
checkout:

```
OUT=/tmp/kb-proof-out npm run repro:shared-browser-keyboard --prefix apps/server
```

The process prints a URL on `127.0.0.1` and writes the same URL to
`OUT/url.txt`. It stays up until stopped. On an already-running emulator,
reverse that port and open the URL in Chrome. `PORT` is the port in the URL.

```
adb -H 127.0.0.1 -P 5037 -s emulator-5634 reverse tcp:PORT tcp:PORT
adb -H 127.0.0.1 -P 5037 -s emulator-5634 shell am start \
  -a android.intent.action.VIEW -d "http://127.0.0.1:PORT/s/..."
```

Tap the Email field so the Android keyboard opens. The page posts measurements
to `OUT/probes.json`: visual viewport height, screen height, canvas, the email
field, and the keyboard button. With the keyboard open those boxes sit in the
visible area. Closing the keyboard restores `flexGrow` to `1`.

Reproduction R1 is the keyboard button staying on screen while the phone is in
control. Reproduction R2 is the email field staying inside the visible area
when that keyboard is open. Screenshots from emulator-5634 are in this folder.

The artifact viewer and the Room composer are the installed Beeline app, not
this page. On emulator-5626, signed in as Beeline Review:

- Search messages for `image`, open `#proof`, open the `upload` image, tap
  Talk to agent, and tap Message. The title stays on screen and the composer
  sits above the keyboard (`artifact-viewer-keyboard.png`).
- Open `#general` and tap the composer. The latest messages and the composer
  stay above the keyboard (`general-composer-keyboard.png`). No message is sent.
