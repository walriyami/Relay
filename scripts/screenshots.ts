// Regenerates the screenshots in docs/images from a disposable local instance filled with generated
// demo content. Nothing here reads real data. Build the client first:
//   npm run build && npm run screenshots [-- --out docs/images]
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, devices, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { cleanUp } from "./lib/verification.ts";
import { api } from "../shared/api.ts";
import { LOCAL_PASSWORD, REPO, Session, freePort, sendFiles, startServer } from "./lib/relay.ts";

const { values: flags } = parseArgs({ options: { out: { type: "string", default: "docs/images" } } });
const out = resolve(REPO, flags.out);

// ---- generated demo content ----

/** A soft landscape: a sky gradient, a sun and two layers of hills. */
function landscape(sky: [string, string], sun: string, hills: [string, string], sunX = 0.68) {
  const [w, h] = [1600, 1200];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
    <circle cx="${w * sunX}" cy="${h * 0.52}" r="${h * 0.13}" fill="${sun}"/>
    <path d="M0 ${h * 0.7} C ${w * 0.25} ${h * 0.55}, ${w * 0.45} ${h * 0.8}, ${w * 0.7} ${h * 0.62} S ${w} ${h * 0.6}, ${w} ${h * 0.6} V ${h} H 0 Z" fill="${hills[0]}"/>
    <path d="M0 ${h * 0.84} C ${w * 0.3} ${h * 0.72}, ${w * 0.6} ${h * 0.95}, ${w} ${h * 0.78} V ${h} H 0 Z" fill="${hills[1]}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const photos = () =>
  Promise.all([
    landscape(["#f7c59f", "#f08a5d"], "#fff1d6", ["#b8505a", "#6a2c47"]),
    landscape(["#a8d8ea", "#e0f4fb"], "#ffffff", ["#5c9ead", "#326273"], 0.3),
    landscape(["#2b2d5b", "#e2725b"], "#ffd29d", ["#433a6b", "#1f1b3a"], 0.5),
    landscape(["#d5e8d4", "#fdf6e3"], "#f6c453", ["#7fb77e", "#3e7c59"], 0.75),
    landscape(["#fbd3e9", "#bb377d"], "#fff5f9", ["#6d214f", "#3b0f2a"], 0.4),
    landscape(["#c9d6ff", "#e2e2e2"], "#fffbe6", ["#8e9eab", "#4b5e6d"], 0.6),
  ]);

/** A one-page PDF with a title, a subtitle and a few lines of body copy. */
function reportPdf() {
  const lines = [
    "0.73 0.23 0.14 rg 0 742 612 50 re f",
    "BT /F1 26 Tf 0.14 0.14 0.13 rg 56 680 Td (Quarterly report) Tj ET",
    "BT /F1 13 Tf 0.4 0.4 0.37 rg 56 656 Td (Third quarter, prepared for the team) Tj ET",
    ...Array.from({ length: 14 }, (_, i) => `0.88 0.88 0.86 rg 56 ${610 - i * 26} ${i % 4 === 3 ? 300 : 500} 10 re f`),
  ];
  const stream = lines.join("\n") + "\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(body);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

const bytes = (size: number) => Buffer.alloc(size, 7);

async function seed(owner: Session) {
  const shots = await photos();
  await owner.call(api.account.update, { body: { name: "Maya" } });
  await sendFiles(owner, [{ path: "Podcast episode 12.mp3", data: bytes(48_000), mime: "audio/mpeg" }]);
  await sendFiles(
    owner,
    [
      {
        path: "Brand kit/Logo.svg",
        data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
        mime: "image/svg+xml",
      },
      { path: "Brand kit/Colors.pdf", data: reportPdf(), mime: "application/pdf" },
      { path: "Brand kit/Fonts/Display.woff2", data: bytes(24_000), mime: "font/woff2" },
    ],
    { folders: ["Brand kit", "Brand kit/Fonts"] },
  );
  await sendFiles(owner, [], {
    name: "Wi-Fi for guests",
    text: "Network: Harbour House\nPassword: ask Maya\nThe router is behind the bookshelf.",
  });
  await sendFiles(owner, [{ path: "Q3 report.pdf", data: reportPdf(), mime: "application/pdf" }]);
  await sendFiles(owner, [{ path: "Sunset.jpg", data: shots[2], mime: "image/jpeg" }]);
  const trip = await sendFiles(
    owner,
    shots.map((data, i) => ({ path: `Lisbon ${String(i + 1).padStart(2, "0")}.jpg`, data, mime: "image/jpeg" })),
    { name: "Lisbon weekend" },
  );
  const link = await owner.call(api.links.create, {
    body: { id: crypto.randomUUID(), item: trip.result.itemId, days: 7, note: "Photos from the weekend. Enjoy!" },
  });
  return { shots, link };
}

// ---- capture ----

async function signIn(page: Page, device: string) {
  const response = await page.request.post(api.session.password.path, {
    data: { username: "admin", password: LOCAL_PASSWORD, deviceName: device },
  });
  if (!response.ok()) throw new Error(`Sign-in failed: ${response.status()}`);
}

const sendTo = (page: Page) => page.getByRole("complementary", { name: "Send to" });

/** Waits for fonts, thumbnails and transitions so every capture is stable. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
}

async function capture(
  browser: Browser,
  origin: string,
  scheme: "light" | "dark",
  demo: Awaited<ReturnType<typeof seed>>,
) {
  const desktop = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1360, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  // A second signed-in device that is online, so Send can offer it as a destination.
  const phone = await browser.newContext({ ...devices["iPhone 13"], baseURL: origin, colorScheme: scheme });
  const guestPhone = await browser.newContext({ ...devices["iPhone 13"], baseURL: origin, colorScheme: scheme });
  try {
    const phonePage = await phone.newPage();
    await signIn(phonePage, "Maya's iPhone");
    await phonePage.goto("/");

    const page = await desktop.newPage();
    await signIn(page, "MacBook Pro");
    await page.goto("/");
    await sendTo(page).getByRole("button", { name: "Maya's iPhone", exact: true }).waitFor();
    await settle(page);
    await page.screenshot({ path: join(out, `send-${scheme}.png`) });

    await page
      .getByTestId("file-input")
      .setInputFiles(
        demo.shots.slice(0, 3).map((buffer, i) => ({ name: `Harbour ${i + 1}.jpg`, mimeType: "image/jpeg", buffer })),
      );
    await sendTo(page).getByRole("button", { name: "Create link" }).click();
    await page.getByRole("button", { name: "Done", exact: true }).waitFor();
    await settle(page);
    await page.screenshot({ path: join(out, `link-${scheme}.png`) });
    await page.getByRole("button", { name: "Done", exact: true }).click();

    await page.goto("/files");
    await settle(page);
    await page.screenshot({ path: join(out, `files-${scheme}.png`) });

    // What someone who received the link sees, signed out, on their phone.
    const guest = await guestPhone.newPage();
    await guest.goto(`/s/${demo.link.token}`);
    await settle(guest);
    await guest.screenshot({ path: join(out, `share-mobile-${scheme}.png`) });
  } finally {
    await desktop.close();
    await phone.close();
    await guestPhone.close();
  }
}

// ---- hero image ----

/** Rounds an image's corners and gives it a hairline border. */
async function framed(image: Buffer, width: number, radius: number, border: string) {
  const resized = await sharp(image).resize({ width }).png().toBuffer();
  const { height } = await sharp(resized).metadata();
  const shape = (fill: string, stroke = "") =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${radius}" fill="${fill}" ${stroke}/></svg>`,
    );
  const rounded = await sharp(resized)
    .composite([{ input: shape("#fff"), blend: "dest-in" }])
    .png()
    .toBuffer();
  const outline = await sharp(rounded)
    .composite([{ input: shape("none", `stroke="${border}" stroke-width="2"`) }])
    .png()
    .toBuffer();
  return { image: outline, width, height: height };
}

/** A soft shadow for a rounded rectangle, padded by `blur` on every side. */
function shadow(width: number, height: number, radius: number, blur: number, opacity: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + blur * 4}" height="${height + blur * 4}">
    <defs><filter id="b"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
    <rect x="${blur * 2}" y="${blur * 2 + blur / 2}" width="${width}" height="${height}" rx="${radius}" fill="rgba(0,0,0,${opacity})" filter="url(#b)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The desktop link result with the guest's phone view overlapping its right edge. */
async function hero(scheme: "light" | "dark") {
  const border = scheme === "dark" ? "#2b2e33" : "#dcdcd7";
  const desktop = await framed(await sharp(join(out, `link-${scheme}.png`)).toBuffer(), 2400, 28, border);
  const screen = await framed(await sharp(join(out, `share-mobile-${scheme}.png`)).toBuffer(), 880, 64, "#000");
  const bezel = 22;
  const phone = { width: screen.width + bezel * 2, height: screen.height + bezel * 2 };
  const phoneBody = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${phone.width}" height="${phone.height}"><rect width="${phone.width}" height="${phone.height}" rx="${64 + bezel}" fill="#0d0d0f" stroke="#3a3b40" stroke-width="3"/></svg>`,
  );
  const blur = 36;
  const pad = blur * 2;
  const phoneAt = { left: pad + desktop.width - 110, top: pad + 150 };
  const width = phoneAt.left + phone.width + pad;
  const height = Math.max(pad + desktop.height, phoneAt.top + phone.height) + pad;
  const shade = scheme === "dark" ? 0.55 : 0.18;
  const composed = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: await shadow(desktop.width, desktop.height, 28, blur, shade), left: 0, top: 0 },
      { input: desktop.image, left: pad, top: pad },
      {
        input: await shadow(phone.width, phone.height, 64, blur, shade * 1.6),
        left: phoneAt.left - pad,
        top: phoneAt.top - pad,
      },
      { input: phoneBody, left: phoneAt.left, top: phoneAt.top },
      { input: screen.image, left: phoneAt.left + bezel, top: phoneAt.top + bezel },
    ])
    .png()
    .toBuffer();
  await sharp(composed)
    .resize({ width: 2000 })
    .png({ compressionLevel: 9 })
    .toFile(join(out, `hero-${scheme}.png`));
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  // Each theme gets its own fresh instance, so both show exactly the same library.
  for (const scheme of ["light", "dark"] as const) {
    const work = await mkdtemp(join(tmpdir(), "relay-screenshots-"));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      await mkdir(join(work, "data"));
      server = await startServer({
        root: join(work, "data"),
        port: await freePort(),
        log: join(work, "server.log"),
      });
      const owner = new Session(server.origin);
      await owner.signIn("admin", LOCAL_PASSWORD, "Seeder");
      await capture(browser, server.origin, scheme, await seed(owner));
      await hero(scheme);
      // The hero is built from these two; the README doesn't use them on their own.
      for (const part of ["link", "share-mobile"]) await rm(join(out, `${part}-${scheme}.png`));
    } finally {
      if (
        await cleanUp([
          { name: "screenshot server", run: () => server?.stop() },
          { name: "screenshot directory", run: () => rm(work, { recursive: true, force: true }) },
        ])
      )
        process.exitCode = 1;
    }
  }
  console.log(`Screenshots written to ${out}`);
} finally {
  if (await cleanUp([{ name: "screenshot browser", run: () => browser.close() }])) process.exitCode = 1;
}
