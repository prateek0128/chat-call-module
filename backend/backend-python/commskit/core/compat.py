"""Legacy wire quirks kept for installed app versions (PROTOCOL.md section 6).

Call-specific quirks (caller view, ``caller_name`` = caller id, busy as
``call_rejected`` with ``call_id: null``) live in ``commskit.call.payloads``.
"""

# Installed apps match the heartbeat reply on the upper-case name.
PONG_TYPE = "PONG"
