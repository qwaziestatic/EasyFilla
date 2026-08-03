import type { FileAttachment } from "../../types/questions";

// chrome messaging JSON-serializes payloads, so file bytes cross the
// sidepanel→content-script boundary base64-encoded rather than as a raw
// ArrayBuffer (which would be dropped). These two helpers are the encode/
// decode pair.

export async function fileToAttachment(questionText: string, file: File): Promise<FileAttachment> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000; // avoid "too many arguments" on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return {
    questionText,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    dataBase64: btoa(binary),
  };
}

// Runs in the content script. Rebuilds a real File so it can be placed into
// a DataTransfer and assigned to input.files.
export function attachmentToFile(attachment: FileAttachment): File {
  const binary = atob(attachment.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], attachment.fileName, { type: attachment.mimeType });
}
