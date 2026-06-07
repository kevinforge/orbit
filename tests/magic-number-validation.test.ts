import assert from "node:assert/strict";
import test from "node:test";
import { AttachmentStore } from "../src/core/attachment-store.ts";

/**
 * Issue #85: 图片文件魔数验证
 *
 * 问题：当前仅检查 MIME 类型字符串，恶意用户可伪造类型上传恶意文件
 *
 * 修复方案：在 validateImageFile 方法中添加魔数（文件头）验证
 * - PNG: 89 50 4E 47 0D 0A 1A 0A
 * - JPEG: FF D8 FF
 * - WebP: RIFF....WEBP
 */

// Valid magic numbers for each format
const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG magic
  0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
  0x49, 0x48, 0x44, 0x52, // IHDR
  // ... rest of PNG data
]);

const VALID_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, // JPEG magic
  0xE0, 0x00, 0x10, // APP0 marker
  0x4A, 0x46, 0x49, 0x46, 0x00, // JFIF
  // ... rest of JPEG data
]);

const VALID_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x00, 0x00, 0x00, 0x00, // file size (placeholder)
  0x57, 0x45, 0x42, 0x50, // WEBP
  // ... rest of WebP data
]);

// Invalid files (wrong magic numbers)
const INVALID_PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0B, // Last byte wrong
]);

const INVALID_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFE, // Last byte wrong
]);

const INVALID_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x51, // Last byte wrong (should be P)
]);

// Malicious file pretending to be PNG but actually is executable
const FAKE_PNG = Buffer.from([
  0x4D, 0x5A, 0x90, 0x00, // MZ header (Windows executable)
  0x03, 0x00, 0x00, 0x00,
]);

test("Issue #85: Valid PNG magic number should pass validation", async () => {
  const result = AttachmentStore.validateImageFile(VALID_PNG, "image/png", "test.png");
  assert.equal(result.valid, true, "Valid PNG should pass validation");
});

test("Issue #85: Valid JPEG magic number should pass validation", async () => {
  const result = AttachmentStore.validateImageFile(VALID_JPEG, "image/jpeg", "test.jpg");
  assert.equal(result.valid, true, "Valid JPEG should pass validation");
});

test("Issue #85: Valid WebP magic number should pass validation", async () => {
  const result = AttachmentStore.validateImageFile(VALID_WEBP, "image/webp", "test.webp");
  assert.equal(result.valid, true, "Valid WebP should pass validation");
});

test("Issue #85: Invalid PNG magic number should fail validation", async () => {
  const result = AttachmentStore.validateImageFile(INVALID_PNG, "image/png", "test.png");
  assert.equal(result.valid, false, "Invalid PNG should fail validation");
  assert.ok(result.error?.includes("does not match"), "Error message should mention mismatch");
});

test("Issue #85: Invalid JPEG magic number should fail validation", async () => {
  const result = AttachmentStore.validateImageFile(INVALID_JPEG, "image/jpeg", "test.jpg");
  assert.equal(result.valid, false, "Invalid JPEG should fail validation");
  assert.ok(result.error?.includes("does not match"), "Error message should mention mismatch");
});

test("Issue #85: Invalid WebP magic number should fail validation", async () => {
  const result = AttachmentStore.validateImageFile(INVALID_WEBP, "image/webp", "test.webp");
  assert.equal(result.valid, false, "Invalid WebP should fail validation");
  assert.ok(result.error?.includes("does not match"), "Error message should mention mismatch");
});

test("Issue #85: Malicious file with forged MIME type should be rejected", async () => {
  const result = AttachmentStore.validateImageFile(FAKE_PNG, "image/png", "malicious.png");
  assert.equal(result.valid, false, "Malicious file should be rejected");
  assert.ok(result.error?.includes("does not match"), "Error message should mention mismatch");
});

test("Issue #85: Empty buffer should fail before magic number check", async () => {
  const result = AttachmentStore.validateImageFile(Buffer.alloc(0), "image/png", "empty.png");
  assert.equal(result.valid, false, "Empty file should fail");
  assert.ok(result.error?.includes("empty"), "Error message should mention empty");
});

test("Issue #85: File too small for magic number check should fail", async () => {
  const smallPng = Buffer.from([0x89, 0x50]); // Only 2 bytes
  const result = AttachmentStore.validateImageFile(smallPng, "image/png", "small.png");
  assert.equal(result.valid, false, "File too small should fail");
});
