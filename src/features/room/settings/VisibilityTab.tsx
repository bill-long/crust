import type { MatrixClient } from "matrix-js-sdk";
import type { Component } from "solid-js";
import { DirectoryPublishingSection } from "./DirectoryPublishingSection";
import { GuestAccessSection } from "./GuestAccessSection";
import { HistoryVisibilitySection } from "./HistoryVisibilitySection";
import { JoinRuleSection } from "./JoinRuleSection";

interface VisibilityTabProps {
	client: MatrixClient;
	roomId: string;
}

/**
 * Space-only "Visibility" tab: consolidates who can discover and join the
 * space. Join rule + history visibility (shared with the Advanced tab for
 * regular rooms) plus guest access and public-directory publishing.
 */
const VisibilityTab: Component<VisibilityTabProps> = (props) => {
	return (
		<div class="space-y-8">
			<JoinRuleSection client={props.client} roomId={props.roomId} />
			<HistoryVisibilitySection client={props.client} roomId={props.roomId} />
			<GuestAccessSection client={props.client} roomId={props.roomId} />
			<DirectoryPublishingSection client={props.client} roomId={props.roomId} />
		</div>
	);
};

export { VisibilityTab };
