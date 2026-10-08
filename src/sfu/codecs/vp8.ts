export function isVp8KeyframeStart(payload: Buffer): boolean {
  if (payload.length < 2) return false;

  let i = 0;
  const b0 = payload[i++];
  const hasExtension = (b0 & 0x80) !== 0;
  const isPartitionStart = (b0 & 0x10) !== 0;
  const partitionId = b0 & 0x07;

  if (!isPartitionStart || partitionId !== 0) return false;

  if (hasExtension) {
    if (i >= payload.length) return false;
    const ext = payload[i++];
    if (ext & 0x80) {
      if (i >= payload.length) return false;
      const pictureId = payload[i++];
      if (pictureId & 0x80) {
        if (i >= payload.length) return false;
        i++;
      }
    }
    if (ext & 0x40) {
      if (i >= payload.length) return false;
      i++;
    }
    if (ext & 0x30) {
      if (i >= payload.length) return false;
      i++;
    }
  }

  if (i >= payload.length) return false;
  return (payload[i] & 0x01) === 0;
}
