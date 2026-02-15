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
- `APNS_USE_SANDBOX=true` for debug/TestFlight dev flow.
- `APNS_USE_SANDBOX=false` for production environment.

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
- Messages are contextual (`dayOfWeek` + `mealType` when available).
- Invalid tokens are auto-disabled (`isActive=false`).
