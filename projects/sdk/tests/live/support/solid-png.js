import { crc32, deflateSync } from "node:zlib"

// Authored solid-color 128px PNG; no remote image or user file enters the fixture
export function solidPngBase64() {
    const chunk = (name, data) => {
        const bytes = Buffer.concat([Buffer.from(name), data])
        const length = Buffer.alloc(4),
            checksum = Buffer.alloc(4)
        length.writeUInt32BE(data.length)
        checksum.writeUInt32BE(crc32(bytes))
        return Buffer.concat([length, bytes, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(128, 0)
    header.writeUInt32BE(128, 4)
    header[8] = 8
    header[9] = 6
    const pixels = Buffer.alloc(128 * 513)
    for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
            const offset = y * 513 + 1 + x * 4
            pixels.set([40, 130, 220, 255], offset)
        }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")
}
