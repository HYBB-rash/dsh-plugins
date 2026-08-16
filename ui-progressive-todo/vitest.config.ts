const harnessReact = process.env.DSH_HARNESS_REACT

if (harnessReact === undefined || harnessReact === '') {
  throw new Error('Set DSH_HARNESS_REACT to the compatible React package directory before running these tests.')
}

export default {
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${harnessReact}/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${harnessReact}/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${harnessReact}/jsx-dev-runtime.js` },
    ],
  },
}
