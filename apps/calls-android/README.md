# GSR Qo'ng'iroqlar (calls-android)

The staff phone app that puts client calls into the CRM. Server half:
`src/modules/wms/calls/**`, `/api/calls/*`; the pairing code lives on each
person's **/profile** («Qo'ng'iroq yozuvi»), the calls appear on the client /
deal / lead cards.

## How it works — and what it deliberately does not do

Android hands **no third-party app the call audio** (since Android 10). So the
recording is made by the PHONE's own recorder (Samsung, Xiaomi/Redmi, Huawei,
Vivo, Oppo all ship one — it must be switched on once in the Phone app's
settings), and this app only:

1. reads the **call register** (number, direction, time, duration) every
   15 minutes — a persisted JobScheduler job, the driver app's v1.3 design:
   no alarm chain, survives reboots, no notification ever;
2. posts it to the server, which answers per call whether the number is in
   the **client book** — a `matched: false` call is dropped on both ends and
   its recording never leaves the phone (personal calls are not the
   company's data);
3. finds the matched calls' recordings THROUGH MEDIASTORE (v1.1 — scoped
   storage neither lists nor stats other apps' files via the File API, it
   only streams them through the resolver; the direct scan of the vendor
   folders remains for pre-Android-11 phones) and uploads them — a
   candidate counts only when its folder says «call» or its name carries
   the number's tail, matched by call window, capped at 25 MB (the
   server's own cap). The audio pass prints its counters on the app
   screen: navbat/topildi/yubordi/rad.

**iPhone cannot do this** — iOS exposes neither the call log nor recordings.
The owner's decision (2026-08-06): planned, not built; iPhone staff stay with
Telegram.

Pairing is per STAFF MEMBER (their own code, their own name on every call),
revocation answers the token with **410** and the app stops and forgets —
never a 401 it would retry for ever (#289).

## Building

CI builds it on every push touching `apps/calls-android/**`
(`.github/workflows/calls-apk.yml`) → artifact `GSRCalls-apk`; publish it from
**Admin → Qo'ng'iroq ilovasi**, staff download it from their /profile.

Local build (needs Android SDK):

```
cd apps/calls-android && ./gradlew assembleRelease
# app/build/outputs/apk/release/app-release.apk
```

`DEFAULT_SERVER` is a compile-time constant (the pairing screen can override
it per phone). A domain move needs all three of: keep serving the old name,
publish a new APK, only then retire the old name — the driver fleet learned
this the hard way (#282).
