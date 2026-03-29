# Weekly Meals 1.0 Release Checklist

## P0 blockers

- [ ] Replace dev login with real authentication for the shipped client
- [ ] Set `AUTH_DEV_LOGIN_ENABLED=false` in production after real auth lands
- [ ] Verify refresh-token rotation in production-like environment
- [ ] Confirm APNs works on a physical iPhone
- [ ] Add crash reporting and error monitoring
- [ ] Prepare privacy policy and support contact for store submission
- [ ] Define data deletion / account removal process
- [ ] Verify backup and rollback path for the production database

## P1 release readiness

- [x] Backend CI workflow exists
- [x] iOS CI workflow exists
- [x] Backend `.env.example` documents deployment variables
- [x] APNs setup doc exists
- [ ] Run full regression on two-user household flows
- [ ] Test offline and reconnect scenarios on device
- [ ] Validate invitation deep links end-to-end
- [ ] Confirm recipe catalog cache invalidation behavior after deploy
- [ ] Confirm R2 image hosting is complete or intentionally disabled
- [ ] Freeze release versions and changelog

## P2 polish

- [ ] Finalize App Store screenshots and metadata
- [ ] Add support / help contact in product-facing materials
- [ ] Prepare internal release notes for support and QA
- [ ] Add operational ownership for deploys, APNs, and DB incidents

## Release-day smoke test

1. Open the app and log in.
2. Verify recipes list loads with images.
3. Add recipes to the weekly plan.
4. Confirm shopping list updates on another logged-in device.
5. Toggle shopping items and confirm realtime sync.
6. Archive and reopen a shopping list.
7. Validate push notification delivery if enabled.
