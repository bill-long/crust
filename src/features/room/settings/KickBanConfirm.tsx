import type { Component } from "solid-js";
import { ConfirmDialog } from "./ConfirmDialog";
import type { MemberAction } from "./useModerationActions";

/**
 * The kick/ban confirmation dialog, shared by the settings Members tab
 * and the profile card host. `onConfirm` may reject - ConfirmDialog then
 * renders the error inline instead of closing first.
 */
const KickBanConfirm: Component<{
	/** The parked kick/ban action; null renders nothing. */
	action: () => MemberAction | null;
	onClose: () => void;
	onConfirm: (action: MemberAction) => Promise<void>;
}> = (props) => {
	return (
		<ConfirmDialog
			open={() => props.action() !== null}
			onClose={props.onClose}
			title={
				props.action()?.kind === "ban"
					? `Ban ${props.action()?.displayName}?`
					: `Kick ${props.action()?.displayName}?`
			}
			body={
				<>
					{/* The MXID, because this is the last screen before an
					    irreversible moderation action and a display name is
					    not an identity - the character policy cannot close
					    impersonation, so the identifier has to be visible.
					    In the body rather than the title: a title long enough
					    to wrap would truncate the identifier, which defeats
					    the point. The name in the title is a plain
					    concatenated string, which is why the policy strips
					    bidi scope controls rather than leaning on CSS
					    containment - CSS cannot reach inside a string. */}
					<p class="mb-2 font-mono text-xs text-text-muted">
						{props.action()?.userId}
					</p>
					<p>
						{props.action()?.kind === "ban"
							? "They won't be able to rejoin unless unbanned."
							: "They can rejoin if the room is public or someone re-invites them."}
					</p>
				</>
			}
			confirmLabel={props.action()?.kind === "ban" ? "Ban" : "Kick"}
			destructive
			onConfirm={async () => {
				const action = props.action();
				if (!action) return;
				await props.onConfirm(action);
				props.onClose();
			}}
		/>
	);
};

export { KickBanConfirm };
