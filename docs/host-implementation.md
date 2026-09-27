# Host control room implementation

Work stays on dev. No release, production deployment or command registration.

1. Shared room lifecycle: exact occurrence, one-time end extension, 30-minute wrap-up, explicit Close room grant and safe idle closure.
2. Host timeline: saved group schedule, standalone depot reminder setting, per-room timing/status overrides, leased bot actions and dispatch acknowledgments.
3. Dashboard: Host above Dispatch, shift timer and extensions, dispatch overview/import, timeline controls, Settings → Schedule.
4. Discord: current occurrence after the end, edit success regression, announcement/server/image updates, shared completion state.
5. Verification: focused concurrency/eligibility tests, all application checks, local Worker runtime and rebuilt Docker stack, desktop/mobile screenshots and CPU measurements.

Timeline changes and extensions affect the open occurrence only. Saved schedule changes apply to newly opened rooms. Automated entries use the corresponding bot feature and automation switches. Reminders require acknowledgment and become ignored at the next scheduled window. Completed/skipped history never moves when the shift is extended.
