using System;
using System.Collections.Generic;
using System.Linq;

namespace InspectaLlamaDO.Models
{
    public class ResearchStateService
    {
        public string ActiveTopic { get; set; } = "";
        public int CurrentStageIndex { get; set; } = 1; // 1: Prompt, 2: Grill, 3: Crawl/Eval, 4: Research, 5: Telemetry

        public List<InteractiveGrillNode> GrillQuestions { get; set; } = new();
        public Dictionary<int, string> SelectedAnswers { get; set; } = new();

        public List<SourceItem> CrawledSources { get; set; } = new();
        public List<ClaimItem> ExtractedClaims { get; set; } = new();

        public SearchResultResponse? FinalResult { get; set; }
        public bool IsProcessing { get; set; }

        public event Action? OnStateChanged;

        public void NotifyStateChanged() => OnStateChanged?.Invoke();

        public void StartNewPipeline(string topic)
        {
            ActiveTopic = topic;
            CurrentStageIndex = 1;
            GrillQuestions.Clear();
            SelectedAnswers.Clear();
            CrawledSources.Clear();
            ExtractedClaims.Clear();
            FinalResult = null;
            IsProcessing = false;
            NotifyStateChanged();
        }

        public void SetGrillQuestions(List<InteractiveGrillNode> questions)
        {
            GrillQuestions = questions;
            SelectedAnswers.Clear();
            for (int i = 0; i < questions.Count; i++)
            {
                var recommended = questions[i].Options.FirstOrDefault(o => o.IsRecommended);
                if (recommended != null)
                {
                    SelectedAnswers[i] = recommended.Text;
                }
                else if (questions[i].Options.Count > 0)
                {
                    SelectedAnswers[i] = questions[i].Options[0].Text;
                }
            }
            CurrentStageIndex = 2;
            NotifyStateChanged();
        }

        public void SetAnswer(int stepIndex, string answerText)
        {
            SelectedAnswers[stepIndex] = answerText;
            NotifyStateChanged();
        }

        public void SetFinalResult(SearchResultResponse result)
        {
            FinalResult = result;
            if (result.Sources != null) CrawledSources = result.Sources;
            if (result.Claims != null) ExtractedClaims = result.Claims;
            CurrentStageIndex = 4;
            NotifyStateChanged();
        }
    }
}
