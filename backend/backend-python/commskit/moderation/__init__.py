"""Block and report (PROTOCOL.md section 7). Depends only on ``commskit.core``.

Works with chat only, call only, or both; ``commskit.integration.link_moderation`` plugs
its block list into the installed chat / call policies and ends live calls on block.
"""

from .feature import ModerationFeature
from .models import Block, Report
from .policy import ModerationCallPolicy, ModerationChatPolicy
from .service import REPORT_CATEGORIES, ModerationService, ReportInfo

__all__ = [
    "Block", "ModerationCallPolicy", "ModerationChatPolicy", "ModerationFeature", "ModerationService",
    "REPORT_CATEGORIES", "Report", "ReportInfo",
]
