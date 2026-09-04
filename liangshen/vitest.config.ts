import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from '../upstream/deepseek-harness/node_modules/typescript/lib/typescript.js'
import { standardDecoratorPlugin } from '../upstream/deepseek-harness/vitest.shared.ts'

const harness = resolve(import.meta.dirname, '../upstream/deepseek-harness')
const paths = ts.parseConfigFileTextToJson('tsconfig.base.json', readFileSync(`${harness}/tsconfig.base.json`, 'utf8')).config.compilerOptions.paths

export default {
  plugins: [standardDecoratorPlugin()],
  resolve: { alias: Object.fromEntries(Object.entries(paths).filter(([name]) => !name.includes('*')).map(([name, values]) => [name, resolve(harness, (values as string[])[0]!)])) },
  test: { include: ['tests/**/*.test.ts', 'src/**/*.test.ts'] },
}
