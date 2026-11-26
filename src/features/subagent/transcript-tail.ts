// Incremental JSONL tailer shared by the subagent tracker and the parent-quota
// monitor. Both read the same agy transcript files; keeping one cursor type and
// one decoder loop is what guarantees multi-byte splits and truncated tails are
// handled identically on the parent and subagent paths.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

export interface JsonlTail {
  /** Bytes already consumed. */
  offset: number
  /** Incremental UTF-8 decoder so split multi-byte characters never corrupt. */
  decoder: StringDecoder
  /** Trailing partial line from the last read (the file ends without a newline). */
  rest: string
}

export function createJsonlTail(offset = 0): JsonlTail {
  return { offset, decoder: new StringDecoder('utf8'), rest: '' }
}

export function fileSizeOrZero(path: string): number {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/** Complete lines appended since the last call; mutates `tail` past them. */
export function readJsonlDelta(path: string, tail: JsonlTail): string[] {
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return []
    size = st.size
  } catch {
    return []
  }
  if (size < tail.offset) {
    tail.offset = 0
    tail.decoder = new StringDecoder('utf8')
    tail.rest = ''
  }
  if (size === tail.offset) return []

  const length = size - tail.offset
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  try {
    const fd = openSync(path, 'r')
    try {
      bytesRead = readSync(fd, buffer, 0, length, tail.offset)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  if (bytesRead <= 0) return []
  tail.offset += bytesRead

  const chunk = tail.rest + tail.decoder.write(buffer.subarray(0, bytesRead))
  const parts = chunk.split('\n')
  tail.rest = parts.pop() ?? ''
  return parts.filter((line) => line.trim() !== '')
}
