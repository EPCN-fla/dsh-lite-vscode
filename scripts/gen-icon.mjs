// Regenerate media/icon.png from media/dsh-logo.svg (requires devDep @resvg/resvg-js).
import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const svg = readFileSync(new URL('../media/dsh-logo.svg', import.meta.url), 'utf8')
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng()
writeFileSync(new URL('../media/icon.png', import.meta.url), png)
console.log('media/icon.png regenerated (256px)')
