// Loads TRON_PRIVATE_KEY_* and other deploy-time config from a local
// .env file (see .env.example). That file is gitignored -- never commit
// a real private key or seed phrase, per docs/deployment-guide.md's
// security checklist.
require('dotenv').config();

module.exports = {
  networks: {
    // Shasta testnet -- get funded here from
    // https://www.trongrid.io/shasta before deploying.
    shasta: {
      privateKey: process.env.TRON_PRIVATE_KEY_SHASTA,
      userFeePercentage: 50,
      feeLimit: 1_000_000_000,
      fullHost: 'https://api.shasta.trongrid.io',
      network_id: '2',
    },
    // Nile testnet -- get funded here from
    // https://nileex.io/join/getJoinPage before deploying.
    nile: {
      privateKey: process.env.TRON_PRIVATE_KEY_NILE,
      userFeePercentage: 100,
      feeLimit: 1_000_000_000,
      fullHost: 'https://nile.trongrid.io',
      network_id: '3',
    },
    // Mainnet is deliberately NOT configured here. Per
    // docs/deployment-guide.md, this project has not been professionally
    // audited -- do not add a mainnet network block or deploy real funds
    // against these contracts until that changes.
  },
  contracts_directory: './contracts',
  contracts_build_directory: './build',
  compilers: {
    solc: {
      version: '0.8.20',
      settings: {
        optimizer: { enabled: true, runs: 200 },
      },
    },
  },
};
