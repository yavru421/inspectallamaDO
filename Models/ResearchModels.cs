using System;
using System.Collections.Generic;

namespace InspectaLlamaDO.Models
{
    public class UserStatus {
        public string UserId { get; set; } = "";
        public string Tier { get; set; } = "free";
        public bool IsPro { get; set; }
        public int SearchesUsed { get; set; }
        public int? SearchesRemaining { get; set; }
        public int? DailyLimit { get; set; }
    }

    public class SearchResultResponse {
        public string Query { get; set; } = "";
        public string Mode { get; set; } = "deep_reasoning";
        public string Synthesis { get; set; } = "";
        public List<ReasoningStep> ReasoningTrace { get; set; } = new();
        public List<ClaimItem> Claims { get; set; } = new();
        public List<EntityItem> Entities { get; set; } = new();
        public List<DisputeItem> Disputes { get; set; } = new();
        public List<SourceItem> Sources { get; set; } = new();
        public string ScreenshotBase64 { get; set; } = "";
        public string Timestamp { get; set; } = "";
        public string FolderId { get; set; } = "default";
    }

    public class ReasoningStep { public int Step { get; set; } public string Description { get; set; } = ""; }

    public class ClaimItem { public string Statement { get; set; } = ""; public string VerbatimQuote { get; set; } = ""; public string SourceTitle { get; set; } = ""; public string SourceUrl { get; set; } = ""; public string EpistemicStatus { get; set; } = "Fact"; public int ConfidenceScore { get; set; } = 95; }

    public class EntityItem { public string Name { get; set; } = ""; public string Category { get; set; } = ""; public string Description { get; set; } = ""; }

    public class DisputeItem { public string Topic { get; set; } = ""; public string PerspectiveA { get; set; } = ""; public string PerspectiveB { get; set; } = ""; }

    public class SourceItem { public string Title { get; set; } = ""; public string Url { get; set; } = ""; public string Snippet { get; set; } = ""; }

    public class EvalResponse { public bool Success { get; set; } public string TargetUrl { get; set; } = ""; public string Evaluation { get; set; } = ""; public string Timestamp { get; set; } = ""; public bool Cached { get; set; } }

    public class WorkspaceFolder { public string Id { get; set; } = Guid.NewGuid().ToString(); public string Name { get; set; } = ""; public string Icon { get; set; } = "📁"; public string ParentId { get; set; } = ""; public DateTime CreatedAt { get; set; } = DateTime.UtcNow; }

    public class ResearchTabSession { public string Id { get; set; } = Guid.NewGuid().ToString(); public string Title { get; set; } = "New Research"; public string Query { get; set; } = ""; public string Mode { get; set; } = "deep_reasoning"; public bool DeepCrawl { get; set; } = true; public string MainTab { get; set; } = "search"; public string ActiveResultTab { get; set; } = "synthesis"; public SearchResultResponse? Result { get; set; } public string FolderId { get; set; } = "default"; public DateTime CreatedAt { get; set; } = DateTime.UtcNow; }
}
