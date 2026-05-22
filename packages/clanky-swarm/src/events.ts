export type SwarmLeaderEvent =
	| {
			type: "swarm.booted";
			instanceId: string;
			scope: string;
			label: string;
	  }
	| {
			type: "swarm.activity";
			instanceId?: string;
			changes: string[];
			activity: unknown;
	  }
	| {
			type: "swarm.error";
			error: string;
	  };

export type SwarmLeaderEventListener = (event: SwarmLeaderEvent) => void;
