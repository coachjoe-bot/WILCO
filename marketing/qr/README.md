# QR codes

These are the QR codes for WILCO event landing pages, generated from `scripts/generate-qr.mjs`. The URL encoded in each code is permanent — the landing page behind it gets toggled active/inactive in code, not moved or replaced — so once a code is printed it never needs reprinting, even if the event it points to changes status.

**Print guidance:** print at least 2×2 inches, keep the white quiet-zone border intact (don't crop it), and test-scan the printed copy from about 2 feet away before the event to make sure it reads cleanly under venue lighting.

To regenerate or add a new location, edit the `TARGETS` array in `scripts/generate-qr.mjs` and run:

```
node scripts/generate-qr.mjs
```
