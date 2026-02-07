export const rangeGuardVaultAbi = [
  {
    type: "event",
    name: "FeesCollected",
    inputs: [
      { name: "positionId", type: "uint256", indexed: true },
      { name: "balance0Before", type: "uint256", indexed: false },
      { name: "balance1Before", type: "uint256", indexed: false },
      { name: "balance0After", type: "uint256", indexed: false },
      { name: "balance1After", type: "uint256", indexed: false },
      { name: "unlockDataHash", type: "bytes32", indexed: false }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "PositionBootstrapped",
    inputs: [
      { name: "newPositionId", type: "uint256", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "unlockDataHash", type: "bytes32", indexed: false }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "PositionRebalanced",
    inputs: [
      { name: "oldPositionId", type: "uint256", indexed: true },
      { name: "newPositionId", type: "uint256", indexed: true },
      { name: "oldLower", type: "int24", indexed: false },
      { name: "oldUpper", type: "int24", indexed: false },
      { name: "newLower", type: "int24", indexed: false },
      { name: "newUpper", type: "int24", indexed: false },
      { name: "unlockDataHash", type: "bytes32", indexed: false }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "PositionStateCleared",
    inputs: [{ name: "positionId", type: "uint256", indexed: true }],
    anonymous: false
  },
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "token0Decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "token1Decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "keeper",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "maxSlippageBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }]
  },
  {
    type: "function",
    name: "positionManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "ticks",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "lower", type: "int24" },
      { name: "upper", type: "int24" },
      { name: "spacing", type: "int24" },
      { name: "positionId", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "isPositionInitialized",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "getPositionIds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "positionCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "bootstrapPosition",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "tickSpacing", type: "int24" },
          { name: "deadline", type: "uint256" },
          { name: "unlockData", type: "bytes" },
          { name: "maxApprove0", type: "uint256" },
          { name: "maxApprove1", type: "uint256" },
          { name: "callValue", type: "uint256" }
        ]
      }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "positionId", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "unlockData", type: "bytes" },
          { name: "callValue", type: "uint256" },
          { name: "maxApprove0", type: "uint256" },
          { name: "maxApprove1", type: "uint256" }
        ]
      }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "closePosition",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "positionId", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "unlockData", type: "bytes" },
          { name: "callValue", type: "uint256" },
          { name: "maxApprove0", type: "uint256" },
          { name: "maxApprove1", type: "uint256" }
        ]
      }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "rebalance",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "positionId", type: "uint256" },
          { name: "newPositionId", type: "uint256" },
          { name: "newTickLower", type: "int24" },
          { name: "newTickUpper", type: "int24" },
          { name: "deadline", type: "uint256" },
          { name: "unlockData", type: "bytes" },
          { name: "maxApprove0", type: "uint256" },
          { name: "maxApprove1", type: "uint256" },
          { name: "callValue", type: "uint256" }
        ]
      }
    ],
    outputs: []
  }
] as const;
