# APNs Setup (Weekly Meals)

## 1. Apple Developer

1. Certificates, IDs & Profiles -> Keys -> `+`
2. Create key with `Apple Push Notifications service (APNs)`.
3. Download `.p8` once.
4. Save:

- `APNS_KEY_ID` (Key ID),
- `APNS_TEAM_ID` (Apple Team ID),
- `APNS_BUNDLE_ID` (iOS bundle id, e.g. `com.yourcompany.weeklymeals`),
- `APNS_PRIVATE_KEY` (content of `.p8` in one line, replace newlines with `\n`).

## 2. Backend `.env`

Set:

```env
APNS_ENABLED=true
APNS_USE_SANDBOX=true
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=XXXXXXXXXX
APNS_BUNDLE_ID=com.yourcompany.weeklymeals
APNS_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

Notes:

- `APNS_USE_SANDBOX` is only a **fallback** for devices registered before the
  `20260827120000_apns_environment_per_device` migration. Every current build
  reports its own environment (`data.apnsEnvironment`: `SANDBOX` for Debug,
  `PRODUCTION` for Release/TestFlight) and the server picks the APNs host per
  device, so one deployment serves both fleets at once.
- Set `APNS_USE_SANDBOX=false` in production, `true` locally.
- A token that answers `BadDeviceToken` is retried once against the other host
  before its row is deactivated; the working environment is then persisted, so
  a mismatch heals itself instead of silencing the device forever.

## 3. iOS app (Xcode)

1. Target -> Signing & Capabilities:

- add `Push Notifications`,
- add `Background Modes` -> `Remote notifications`.

2. Build and run app on a physical iPhone.
3. Login in app (token registration runs automatically after auth).

## 4. Verify

1. Check DB:

```sql
select "userId","deviceToken","appBundleId","isActive" from "PushDevice";
```

2. In backend logs, on startup you should see:

- `APNs enabled (sandbox|production)` (or warning if config incomplete).

## 5. Current behavior

- Push is sent to all active iOS devices in household except actor.
- Invalid tokens are auto-disabled (`isActive=false`).

### Batching — one push per editing session, not per change

Plan and shopping-list events are **not** sent one by one. They land in an
in-memory buffer keyed by `household + week + actor`, and one summary goes out
after the actor stops changing things:

| Channel       | Quiet window | Hard ceiling | Env override                                                  |
| ------------- | ------------ | ------------ | ------------------------------------------------------------- |
| Weekly plan   | 60 s         | 5 min        | `PUSH_BATCH_QUIET_MS` / `PUSH_BATCH_MAX_MS`                   |
| Shopping list | 3 min        | 15 min       | `PUSH_SHOPPING_BATCH_QUIET_MS` / `PUSH_SHOPPING_BATCH_MAX_MS` |

The buffer lives in the API process. It is lost on restart (one summary may be
dropped) and it assumes **a single API instance** — with several replicas each
would send its own summary. See `src/notifications/notification-batcher.ts`.

Not every plan write notifies: a `weeklyPlans:upsertWeekSlot` that lands on an
existing item (servings stepper, audience chips) returns `changeKind` other than
`CREATED` and is skipped. Marking a meal as eaten never notified and still
doesn't.

### Delivery style

- plan summaries: `interruption-level: active`, sound, `apns-priority: 10`,
  2 h expiration — and the client shows them as a banner in the foreground too,
- shopping summaries: quiet, Notification Center only while the app is open,
- `apns-collapse-id` per household+week — a newer summary replaces the older one
  instead of stacking,
- `aps.thread-id = household-<id>` groups everything from one household,
- household join/leave: immediate, `active`, with sound (rare and awaited),
- household invitation (`type: HOUSEHOLD_INVITATION`): immediate, `active`,
  collapsed per household. Sent when an invitation link is first opened by a
  signed-in user, which is the only moment the anonymous link acquires a
  recipient. The client deliberately shows it _without_ a banner while the app
  is in the foreground — its job is to leave a trace in Notification Center
  that survives the alert being dismissed.

### Per-user preferences

`UserPreference.pushPlanChanges` / `pushShoppingList` / `pushHousehold` /
`pushQuietHours` / `timeZone` (migration `20260823210000_notification_preferences`).
The iOS switches in Ustawienia → Powiadomienia sync into that row via
`users:preferences:update`; before this they lived only in `UserDefaults` and
silenced local banners while pushes kept coming.

Only **plan** and **shopping** have their own switches in the app.
`pushHousehold` follows the master switch alone (join/leave is too rare and
too important to mute separately) and `pushQuietHours` is pinned `true` by the
client — quiet hours are app behaviour, not a preference. The columns stay so
the server-side filter keeps working and the decision can be reversed without
another migration.

Quiet hours are 22:00–07:00 in the user's `timeZone` (defaults to
`Europe/Warsaw`). A batch that would flush inside the window waits for its end
rather than being dropped.
