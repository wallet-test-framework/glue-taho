## Wallet Test Framework: Taho

A tool to automate the Taho wallet use use with Wallet Test Framework.

## Installation

### Node

This project requires Nodejs version 20.6 or later.

### Dependencies

```bash
npm install
```

### Chrome Extension

The glue requires a local copy of Taho Wallet. The publicly available extension may be fetched with:

```bash
wget \
    -O taho.crx \
    'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=118.0.5993.70&acceptformat=crx2,crx3&x=id%3Deajafomhmkipbjmfmhebemolkcicgfmd%26uc'
```

## Building

```bash
npm run build
```

### Tests & Linting (Optional)

```bash
npm test
```

## Running

```bash
npx glue-taho \
    --extension-path /path/to/crx/file
```
