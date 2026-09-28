# Client resource lifecycle checks

Run `npm run test:resources` (Chromium, Firefox and WebKit). Set `RELAY_RESOURCE_PORT` to an unused port when another checkout is running browser tests.

This Vite fixture mounts the production `PdfPreview` and `DeviceCode` components with the production styles. It does not require or mutate server data. The real PDF case renders every page of a generated 300-page document, revisits released pages, resizes, closes and reopens the preview, and checks independent thumbnail-worker operation.

A real 300-page short/wide PDF checks that every visible page renders, including more than six pages at once. A tall viewport forces those pages to share the fixed 12-million-pixel output budget. A separate native-worker case serves a module that never answers pdf.js messages and verifies that close and the document startup deadline both terminate the actual Worker.

The deterministic PDF module in `pdf-mock.txt` is returned only by Playwright's route interception. Delayed loading and asynchronous render cancellation expose races that a small real PDF may finish too quickly to reproduce. It checks render/load concurrency, same-page serialization, page cleanup and late worker/document/page resolution. Canvas property instrumentation retains references to detached canvases to verify their backing dimensions return to zero.

Visibility tests simulate browser visibility events and advance the browser clock. They cover hidden countdown/polling, redemption, expiry, revocation and an in-flight status request across hide/show.

These checks establish canvas dimension and work limits, not browser RSS or physical iOS/Android stability. Physical device acceptance remains a release check.
