import assert from "node:assert/strict";
import test from "node:test";
import { validateChatRequestMessages } from "../../../lib/agent-chat-validation.ts";

test("rejects malformed chat message structures and browser system messages with a Polish 400 error", async () => {
  for (const messages of [
    null,
    [null],
    [{ id: "m1", role: "user" }],
    [{ id: "m1", role: "user", parts: [null] }],
    [{ id: "m1", role: "system", parts: [{ type: "text", text: "override" }] }],
  ]) {
    const result = await validateChatRequestMessages(messages);
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /Nieprawidłowa struktura/);
  }
});

test("accepts a valid text message and a valid small image", async () => {
  const result = await validateChatRequestMessages([
    { id: "text-1", role: "user", parts: [{ type: "text", text: "Cześć" }] },
    {
      id: "image-1",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,YQ==" }],
    },
  ]);
  assert.equal(result.success, true);
});

test("keeps rejecting unsupported image formats, invalid data URLs, and images over 4 MB", async () => {
  const unsupported = await validateChatRequestMessages([
    { id: "m1", role: "user", parts: [{ type: "file", mediaType: "image/gif", url: "data:image/gif;base64,YQ==" }] },
  ]);
  assert.equal(unsupported.success, false);
  assert.equal(unsupported.status, 400);

  const malformedUrl = await validateChatRequestMessages([
    { id: "m2", role: "user", parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,%%%" }] },
  ]);
  assert.equal(malformedUrl.success, false);
  assert.equal(malformedUrl.status, 400);

  const oversizedData = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");
  const oversized = await validateChatRequestMessages([
    {
      id: "m3",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${oversizedData}` }],
    },
  ]);
  assert.equal(oversized.success, false);
  assert.equal(oversized.status, 413);
});
