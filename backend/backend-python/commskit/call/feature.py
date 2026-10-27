"""CallFeature(...).install(hub)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .bridge import CallChatBridge
from .config import CallConfig
from .handlers import CallHandlers
from .lifecycle import CallLifecycle
from .policy import AllowAllCallPolicy, CallPolicy
from .router import build_call_router

if TYPE_CHECKING:
    from commskit.core.hub import CommsHub


class CallFeature:
    """P2P WebRTC call signalling. Works standalone (``chat_id`` null, no call_log);
    ``commskit.integration.link_chat_and_call`` sets ``chat_bridge``."""

    name = "call"

    def __init__(self, policy: CallPolicy | None = None, config: CallConfig | None = None) -> None:
        self.policy: CallPolicy = policy or AllowAllCallPolicy()
        self.config = config or CallConfig()
        self.chat_bridge: CallChatBridge | None = None
        self._hub: "CommsHub | None" = None
        self.lifecycle: CallLifecycle
        self.handlers: CallHandlers

    @property
    def hub(self) -> "CommsHub":
        if self._hub is None:
            raise RuntimeError("CallFeature is not installed; call .install(hub) first")
        return self._hub

    def install(self, hub: "CommsHub") -> "CallFeature":
        hub.register_feature(self.name, self)
        self._hub = hub
        self.lifecycle = CallLifecycle(self)
        self.handlers = CallHandlers(self)
        self.handlers.register()
        hub.on_connect(self.lifecycle.on_connect)
        hub.on_disconnect(self.lifecycle.end_calls_after_disconnect)
        hub.include_router(build_call_router(self))
        return self

    async def delete_user_data(self, user_id: str) -> dict[str, int]:
        """Account deletion: remove every calls row where the user is caller or receiver.

        Live calls are not signalled; disconnect the user first (or end their calls) if needed."""
        from sqlalchemy import delete, or_

        from .models import Call

        async with self.hub.session_factory() as session:
            result = await session.execute(
                delete(Call).where(or_(Call.caller_id == str(user_id), Call.receiver_id == str(user_id)))
                .execution_options(synchronize_session=False)
            )
            await session.commit()
        return {"calls": int(result.rowcount or 0)}
