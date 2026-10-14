import { cleanup, render, screen } from "@solidjs/testing-library";
import {
	createClient,
	KnownMembership,
	MatrixEvent,
	Room,
} from "matrix-js-sdk";
import {
	MatrixRTCSession,
	MatrixRTCSessionEvent,
} from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { fetchLivekitToken } from "./fetchLivekitToken";
import { type RtcSessionApi, useRtcSession } from "./useRtcSession";

afterEach(cleanup);

it.each([false, true])(
	"Join publishes an RTC membership before media can use its identity (retry fallback: %s)",
	async (initialFallback) => {
		let discoveries = 0;
		const client = createClient({
			baseUrl: "https://matrix.example.org",
			userId: "@alice:example.org",
			deviceId: "DEVICE",
			accessToken: "test",
		});
		const room = new Room("!room:example.org", client, "@alice:example.org");
		room.updateMyMembership(KnownMembership.Join);
		room.currentState.setStateEvents([
			new MatrixEvent({
				room_id: room.roomId,
				type: "m.room.power_levels",
				state_key: "",
				sender: "@owner:example.org",
				content: { users_default: 0, state_default: 50, events_default: 0 },
			}),
			new MatrixEvent({
				room_id: room.roomId,
				type: "m.room.member",
				state_key: "@alice:example.org",
				sender: "@alice:example.org",
				content: { membership: "join" },
			}),
		]);
		expect(
			room.currentState.maySendStateEvent(
				"org.matrix.msc3401.call.member",
				"@alice:example.org",
			),
		).toBe(false);
		expect(
			room.currentState.maySendEvent(
				"org.matrix.msc4143.rtc.member",
				"@alice:example.org",
			),
		).toBe(true);
		vi.spyOn(client, "getRoom").mockReturnValue(room);
		vi.spyOn(client, "doesServerSupportUnstableFeature").mockResolvedValue(
			true,
		);
		const session = new MatrixRTCSession(client, room, {
			application: "m.call",
			id: "ROOM",
		});
		vi.spyOn(client.matrixRTC, "getRoomSession").mockReturnValue(session);
		vi.spyOn(
			client,
			"_unstable_restartScheduledDelayedEvent",
		).mockResolvedValue({});
		vi.spyOn(client, "_unstable_sendScheduledDelayedEvent").mockResolvedValue(
			{},
		);
		const keyIdentities = new Set<string>();
		session.on(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			(_key, _index, _member, identity) => {
				keyIdentities.add(identity);
			},
		);
		let api: RtcSessionApi | undefined;
		const sent = vi
			.spyOn(client, "_unstable_sendStickyEvent")
			.mockResolvedValue({ event_id: "$member" });
		vi.spyOn(client, "_unstable_sendStickyDelayedEvent").mockResolvedValue({
			delay_id: "delay",
		});
		vi.spyOn(client, "sendStateEvent").mockResolvedValue({
			event_id: "$legacy",
		});
		vi.spyOn(client, "_unstable_sendDelayedStateEvent").mockResolvedValue({
			delay_id: "delay",
		});
		try {
			render(() => {
				const rtc = useRtcSession({
					client,
					roomId: room.roomId,
					elementCallUrl: "",
					e2ee: () =>
						({
							attach: () => () => {},
							reemit: () => session.reemitEncryptionKeys(),
						}) as never,
					discoverFoci: async () =>
						initialFallback && discoveries++ === 0
							? [
									{
										type: "livekit",
										livekit_service_url: "https://fallback.example",
									},
								]
							: [
									{
										type: "livekit",
										livekit_service_url: "https://jwt.example.org",
										livekit_alias: room.roomId,
										url: "wss://sfu.example.org",
									},
								],
				});
				api = rtc;
				return (
					<>
						<button
							type="button"
							disabled={!rtc.canJoin() && !rtc.canRetryDiscovery()}
							onClick={() => {
								if (rtc.canJoin()) void rtc.join();
								else void rtc.retryDiscovery();
							}}
						>
							{rtc.canRetryDiscovery() ? "Retry call setup" : "Join"}
						</button>
						<span>{rtc.error()?.message}</span>
					</>
				);
			});
			await expect
				.poll(() => (screen.getByRole("button") as HTMLButtonElement).disabled)
				.toBe(false);
			if (initialFallback) {
				await userEvent.click(
					screen.getByRole("button", { name: "Retry call setup" }),
				);
				await expect.poll(() => api?.canJoin()).toBe(true);
			}
			await userEvent.click(screen.getByRole("button", { name: "Join" }));
			expect(api?.error()).toBeNull();
			await expect.poll(() => sent.mock.calls.length).toBeGreaterThan(0);
			const content = sent.mock.calls[0]?.[4];
			if (!content) throw new Error("Missing published membership");
			expect(content).toMatchObject({
				slot_id: "m.call#ROOM",
				member: { user_id: "@alice:example.org", device_id: "DEVICE" },
			});
			const own = api?.localMembership();
			const focus = api?.activeFocus();
			if (!own || !focus) throw new Error("Missing negotiated membership");
			expect(content).toMatchObject({
				member: { id: own.memberId },
				transports: {
					published: [
						{
							type: "livekit",
							url: "wss://sfu.example.org",
							livekit_service_url: "https://jwt.example.org",
						},
					],
				},
			});
			room._unstable_addStickyEvents([
				new MatrixEvent({
					room_id: room.roomId,
					type: "org.matrix.msc4143.rtc.member",
					event_id: "$member",
					sender: own.userId,
					origin_server_ts: Date.now(),
					content,
					msc4354_sticky: { duration_ms: 60000 },
					unsigned: { msc4354_sticky_duration_ttl_ms: 60000 },
				}),
			]);
			await expect
				.poll(() => keyIdentities.has(own.backendIdentity), { timeout: 5000 })
				.toBe(true);
			expect(keyIdentities.has("@alice:example.org:DEVICE")).toBe(true);
			const tokenRequest = vi
				.spyOn(client.http, "authedRequest")
				.mockResolvedValue({ jwt: "JWT" });
			const result = await fetchLivekitToken(
				focus,
				{
					access_token: "openid",
					token_type: "Bearer",
					matrix_server_name: "example.org",
					expires_in: 60,
				},
				"DEVICE",
				{ client, membership: own },
			);
			expect(result.localIdentity).toBe(own.backendIdentity);
			expect(tokenRequest.mock.calls[0]?.[3]).toMatchObject({
				member_id: own.memberId,
				room_id: room.roomId,
			});
		} finally {
			cleanup();
			await session.stop();
		}
	},
);
