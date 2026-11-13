// Generated from helper consumer adapters by scripts/generate-network-codecs.mjs.
import type { WireShape } from './wire-codec.js';
const shape = (value: WireShape): WireShape => value;
export const helperShapes: readonly WireShape[] = [
  shape({"kind":"intersection","choices":[1,3,7]}),
  shape({"kind":"object","properties":{"agentId":{"node":2,"optional":false}}}),
  shape({"kind":"string"}),
  shape({"kind":"object","properties":{"source":{"node":4,"optional":false},"account":{"node":6,"optional":false},"revision":{"node":2,"optional":false}}}),
  shape({"kind":"object","properties":{"connectionId":{"node":2,"optional":false},"epoch":{"node":5,"optional":false}}}),
  shape({"kind":"number"}),
  shape({"kind":"object","properties":{"provider":{"node":2,"optional":false},"key":{"node":2,"optional":false}}}),
  shape({"kind":"object","properties":{"source":{"node":8,"optional":false}}}),
  shape({"kind":"object","properties":{"connectionId":{"node":2,"optional":false},"epoch":{"node":5,"optional":false}}}),
  shape({"kind":"object","properties":{"id":{"node":2,"optional":false},"createdAt":{"node":5,"optional":false},"failureReportDelivered":{"node":10,"optional":true}}}),
  shape({"kind":"union","choices":[11,12,13]}),
  shape({"kind":"undefined"}),
  shape({"kind":"literal","value":false}),
  shape({"kind":"literal","value":true}),
  shape({"kind":"intersection","choices":[1,15]}),
  shape({"kind":"object","properties":{"usage":{"node":16,"optional":false},"usageSource":{"node":45,"optional":true}}}),
  shape({"kind":"object","properties":{"updatedAt":{"node":5,"optional":false},"windows":{"node":17,"optional":false},"context":{"node":25,"optional":true},"free":{"node":27,"optional":true},"spend":{"node":29,"optional":true},"plan":{"node":24,"optional":true},"credits":{"node":31,"optional":true},"read":{"node":33,"optional":true},"account":{"node":41,"optional":true},"sharedWith":{"node":43,"optional":true},"machine":{"node":24,"optional":true}}}),
  shape({"kind":"array","item":18}),
  shape({"kind":"object","properties":{"rateLimitType":{"node":2,"optional":false},"status":{"node":19,"optional":false},"utilization":{"node":23,"optional":true},"resetsAt":{"node":23,"optional":true},"updatedAt":{"node":5,"optional":false},"label":{"node":24,"optional":true}}}),
  shape({"kind":"union","choices":[20,21,22]}),
  shape({"kind":"literal","value":"allowed"}),
  shape({"kind":"literal","value":"allowed_warning"}),
  shape({"kind":"literal","value":"rejected"}),
  shape({"kind":"union","choices":[11,5]}),
  shape({"kind":"union","choices":[11,2]}),
  shape({"kind":"union","choices":[11,26]}),
  shape({"kind":"object","properties":{"used":{"node":5,"optional":false},"size":{"node":5,"optional":false}}}),
  shape({"kind":"union","choices":[11,28]}),
  shape({"kind":"object","properties":{"used":{"node":5,"optional":false},"limit":{"node":5,"optional":false},"resetsAt":{"node":5,"optional":false},"paused":{"node":10,"optional":true}}}),
  shape({"kind":"union","choices":[11,30]}),
  shape({"kind":"object","properties":{"today":{"node":23,"optional":true},"week":{"node":23,"optional":true},"limit":{"node":23,"optional":true},"remaining":{"node":23,"optional":true},"rejected":{"node":10,"optional":true}}}),
  shape({"kind":"union","choices":[11,32]}),
  shape({"kind":"object","properties":{"remaining":{"node":5,"optional":false}}}),
  shape({"kind":"union","choices":[11,34]}),
  shape({"kind":"object","properties":{"status":{"node":35,"optional":false},"at":{"node":5,"optional":false},"reason":{"node":24,"optional":true},"retryAfter":{"node":23,"optional":true}}}),
  shape({"kind":"union","choices":[36,37,38,39,40]}),
  shape({"kind":"literal","value":"failed"}),
  shape({"kind":"literal","value":"fresh"}),
  shape({"kind":"literal","value":"stale"}),
  shape({"kind":"literal","value":"signed_out"}),
  shape({"kind":"literal","value":"rate_limited"}),
  shape({"kind":"union","choices":[11,42]}),
  shape({"kind":"object","properties":{"provider":{"node":2,"optional":false},"key":{"node":2,"optional":false}}}),
  shape({"kind":"union","choices":[11,44]}),
  shape({"kind":"array","item":2}),
  shape({"kind":"union","choices":[11,46]}),
  shape({"kind":"object","properties":{"v":{"node":47,"optional":false},"ownerId":{"node":2,"optional":false},"source":{"node":4,"optional":false},"revision":{"node":5,"optional":false}}}),
  shape({"kind":"literal","value":1}),
  shape({"kind":"intersection","choices":[1,49]}),
  shape({"kind":"object","properties":{"usage":{"node":16,"optional":false},"revision":{"node":2,"optional":false},"ownerId":{"node":2,"optional":false},"source":{"node":50,"optional":false}}}),
  shape({"kind":"object","properties":{"connectionId":{"node":2,"optional":false},"epoch":{"node":5,"optional":false}}}),
  shape({"kind":"intersection","choices":[9,52]}),
  shape({"kind":"object","properties":{"accountId":{"node":2,"optional":false},"ownerId":{"node":2,"optional":false},"revision":{"node":2,"optional":false},"superseded":{"node":53,"optional":true}}}),
  shape({"kind":"union","choices":[11,13]})
];
export const helperOperations = {
  "daemon.attachAgentUsageAccount": {
    "input": 0,
    "output": 9
  },
  "daemon.postAgentUsage": {
    "input": 14,
    "output": 9
  },
  "daemon.publishAgentUsageAccount": {
    "input": 48,
    "output": 51
  }
} as const;
