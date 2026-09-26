import assert from "node:assert/strict";
import test from "node:test";
import { tabTitle, uploadStatus } from "../client/lib/tab-title.ts";
import type { Transfer } from "../client/lib/transfers";

const upload = (status: Transfer["status"], sentBytes: number, totalBytes = 100) => ({ status, sentBytes, totalBytes });

test("the title is always Relay, led by what is waiting and the upload's progress", () => {
  assert.equal(tabTitle(0, ""), "Relay");
  assert.equal(tabTitle(2, ""), "(2) Relay");
  assert.equal(tabTitle(0, "↑ 42%"), "↑ 42% · Relay");
  assert.equal(tabTitle(3, "↑ 42%"), "(3) ↑ 42% · Relay");
  assert.equal(tabTitle(120, ""), "(99+) Relay");
});

test("upload progress combines this tab's transfers by bytes and never shows 100% early", () => {
  assert.equal(uploadStatus([]), "");
  assert.equal(uploadStatus([upload("uploading", 42)]), "↑ 42%");
  assert.equal(uploadStatus([upload("uploading", 10, 100), upload("uploading", 290, 300)]), "↑ 75%");
  assert.equal(uploadStatus([upload("uploading", 100)]), "↑ 99%", "the server has not confirmed it yet");
  assert.equal(uploadStatus([upload("uploading", 500)]), "↑ 99%", "resent bytes never overshoot");
  assert.equal(uploadStatus([upload("preparing", 0, 0)]), "↑ 0%");
});

test("paused, finishing, attention and cancelling uploads read as what they are", () => {
  assert.equal(uploadStatus([upload("paused", 30)]), "Paused 30%");
  assert.equal(uploadStatus([upload("paused", 30), upload("uploading", 50)]), "↑ 40%");
  assert.equal(uploadStatus([upload("finishing", 100)]), "↑ Finishing");
  assert.equal(uploadStatus([upload("uploading", 5), upload("attention", 0)]), "Upload needs attention");
  assert.equal(uploadStatus([upload("destination", 100)]), "Upload needs attention");
  assert.equal(uploadStatus([upload("cancelling", 50)]), "", "a cancelled upload is not progress");
  assert.equal(uploadStatus([upload("cancelling", 0), upload("uploading", 20)]), "↑ 20%");
});
