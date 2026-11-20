using System.Text.RegularExpressions;

namespace BlipDesk;

public enum EntryKind { Summary, Region, Item, ReadAll, Control, PageStep, Fields }

/// <summary>One line in the Page list.</summary>
public sealed record PageEntry(string Text, EntryKind Kind, string? Id = null, OutlineRegion? Region = null, DeskControl? Control = null, bool Hidden = false)
{
    public bool IsList => Region is { Kind: "list", Items.Count: > 0 };
    /// <summary>True for the main column's results list, which is selected after every page change.</summary>
    public bool IsResults { get; init; }
    public override string ToString() => Text;
}

/// <summary>
/// Turns a raw outline into the list a screen reader user hears, the way a sighted reader scans:
/// the main column first (with its biggest list named "Results" and next/previous page steps),
/// then side columns, then menus, with noise hidden unless asked for.
/// </summary>
public static partial class PageView
{
    private static readonly HashSet<string> HiddenNoise = ["ad-frame", "ad-marker", "sponsored", "cookie-banner", "offscreen", "link-farm"];
    private static readonly HashSet<string> SecondaryNoise = ["link-row", "pagination"];
    private static readonly HashSet<string> SecondaryKinds = ["navigation", "banner", "contentinfo"];

    [GeneratedRegex(@"\bpage\s+(\d{1,6})\s+of\s+(\d{1,7})\b", RegexOptions.IgnoreCase)]
    private static partial Regex PageOfRegex();

    [GeneratedRegex(@"^\s*(next|next page|older|more results|›|»|>|→)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex NextRegex();

    [GeneratedRegex(@"^\s*(prev|previous|previous page|newer|‹|«|<|←)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex PreviousRegex();

    public static List<PageEntry> Build(PageOutline outline, bool showHidden, (DeskControl? Next, DeskControl? Previous) steps = default)
    {
        // Steps the extension found by rel= and labels win; the page-number guess fills the gaps.
        var found = outline.Steps;
        steps = (found?.Next ?? steps.Next, found?.Previous ?? steps.Previous);
        var more = found?.More;
        var visible = new List<OutlineRegion>();
        var hidden = new List<PageEntry>();
        foreach (var region in outline.Regions)
        {
            var reason = HiddenReason(region);
            if (reason is null) visible.Add(region);
            else hidden.Add(new PageEntry($"{Describe(region)}, hidden: {reason}", EntryKind.Region, region.Id, region, Hidden: true));
        }

        // The results list anchors the main column; without one, fall back to a main landmark or widest area.
        var results = ResultsList(visible, null);
        var main = results ?? MainColumn(visible);
        var pager = visible.FirstOrDefault(r => r.Noise.Contains("pagination"));

        var primary = new List<PageEntry>();
        var side = new List<PageEntry>();
        var menus = new List<PageEntry>();
        foreach (var region in visible.OrderBy(r => r.Rect.Y).ThenBy(r => r.Rect.X))
        {
            if (region == pager) continue; // offered as next/previous steps, and listed at the end
            var isResults = region == results;
            var text = isResults ? ResultsText(region, outline) : Describe(region);
            var entry = new PageEntry(text, EntryKind.Region, region.Id, region) { IsResults = isResults };
            if (IsSecondary(region)) menus.Add(entry);
            else if (main is not null && region != main && IsBeside(region, main)) side.Add(entry with { Text = $"{text}, sidebar" });
            else primary.Add(entry);
            if (isResults) primary.AddRange(StepEntries(steps, more));
        }
        if (results is null) primary.AddRange(StepEntries(steps, more));

        var summary = Summary(outline, primary.Count, side.Count + menus.Count, hidden.Count, showHidden, results is not null);
        var entries = new List<PageEntry> { new(summary, EntryKind.Summary) };
        entries.AddRange(primary);
        entries.AddRange(side);
        entries.AddRange(menus);
        if (pager is not null) entries.Add(new PageEntry(Describe(pager), EntryKind.Region, pager.Id, pager));
        if (showHidden) entries.AddRange(hidden);
        return entries;
    }

    /// <summary>
    /// The main column: an explicit main landmark if there is one, otherwise the widest tall
    /// content area that isn't the site header, footer, or a menu.
    /// </summary>
    private static OutlineRegion? MainColumn(List<OutlineRegion> regions)
    {
        var landmark = regions.Where(r => r.Kind == "main" && r.Rect.W > 0).OrderByDescending(r => (long)r.Rect.W * r.Rect.H).FirstOrDefault();
        if (landmark is not null) return landmark;
        return regions
            .Where(r => r.Kind is "section" or "list" or "complementary" or "form" && r.Rect.H >= 300 && r.Rect.W >= 300)
            .OrderByDescending(r => r.Rect.W)
            .ThenByDescending(r => r.Rect.H)
            .FirstOrDefault();
    }

    /// <summary>The biggest list inside the main column (by items, then area).</summary>
    private static OutlineRegion? ResultsList(List<OutlineRegion> regions, OutlineRegion? main)
    {
        var lists = regions.Where(r => r.Kind == "list" && (r.Items?.Count ?? 0) >= 3 && !r.Noise.Any(SecondaryNoise.Contains));
        if (main is not null) lists = lists.Where(r => r == main || Contains(main, r));
        return lists.OrderByDescending(r => r.Items!.Count).ThenByDescending(r => (long)r.Rect.W * r.Rect.H).FirstOrDefault();
    }

    private static bool Contains(OutlineRegion outer, OutlineRegion inner) =>
        inner.Rect.X >= outer.Rect.X - 10 && inner.Rect.X + inner.Rect.W <= outer.Rect.X + outer.Rect.W + 10 &&
        inner.Rect.Y >= outer.Rect.Y - 10 && inner.Rect.Y <= outer.Rect.Y + outer.Rect.H;

    /// <summary>True when a region sits wholly to the left or right of the main column.</summary>
    private static bool IsBeside(OutlineRegion region, OutlineRegion main) =>
        region.Rect.W > 0 && (region.Rect.X + region.Rect.W <= main.Rect.X + 10 || region.Rect.X >= main.Rect.X + main.Rect.W - 10);

    private static string ResultsText(OutlineRegion region, PageOutline outline)
    {
        var count = region.Items?.Count ?? 0;
        var page = PageOfRegex().Match(outline.Title);
        var where = page.Success ? $", page {page.Groups[1].Value} of {page.Groups[2].Value}" : "";
        return $"Results{where}, {Count(count, "item")}";
    }

    /// <summary>The page-number region of an outline, if any.</summary>
    public static OutlineRegion? Pager(PageOutline outline) =>
        outline.Regions.FirstOrDefault(r => r.Noise.Contains("pagination") && HiddenReason(r) is null);

    /// <summary>
    /// Next/previous links among the page-number area's real links: by label ("Next", "›"),
    /// else by the number one above or below the current page taken from the title.
    /// </summary>
    public static (DeskControl? Next, DeskControl? Previous) FindPageSteps(PageOutline outline, RegionControls controls)
    {
        var links = controls.Controls.Where(c => c.Kind == "link" && c.Access != "blocked").ToList();
        var next = links.FirstOrDefault(c => NextRegex().IsMatch(c.Label));
        var previous = links.FirstOrDefault(c => PreviousRegex().IsMatch(c.Label));
        var page = PageOfRegex().Match(outline.Title);
        if (page.Success && int.TryParse(page.Groups[1].Value, out var current))
        {
            next ??= links.FirstOrDefault(c => c.Label.Trim() == (current + 1).ToString());
            if (current > 1) previous ??= links.FirstOrDefault(c => c.Label.Trim() == (current - 1).ToString());
        }
        return (next, previous);
    }

    private static IEnumerable<PageEntry> StepEntries((DeskControl? Next, DeskControl? Previous) steps, DeskControl? more = null)
    {
        if (more is not null) yield return new PageEntry($"{more.Label}, button", EntryKind.Control, more.Id, Control: more);
        if (steps.Next is not null) yield return new PageEntry("Next page", EntryKind.Control, steps.Next.Id, Control: steps.Next);
        if (steps.Previous is not null) yield return new PageEntry("Previous page", EntryKind.Control, steps.Previous.Id, Control: steps.Previous);
    }

    /// <summary>Entries for the items inside one list region, led by a summary line.</summary>
    public static List<PageEntry> BuildItems(OutlineRegion list, string? title = null)
    {
        var items = list.Items ?? [];
        var entries = new List<PageEntry>
        {
            new($"{title ?? Name(list)}: {Count(items.Count, "item")}. Enter for choices, Control Enter opens it, Escape goes back.", EntryKind.Summary),
        };
        foreach (var item in items)
        {
            var extra = item.Preview.StartsWith(item.Label, StringComparison.Ordinal) ? item.Preview[item.Label.Length..].Trim() : "";
            var text = extra.Length > 0 ? $"{item.Label}. {Shorten(extra, 140)}" : item.Label;
            entries.Add(new PageEntry(text, EntryKind.Item, item.Id));
        }
        return entries;
    }

    /// <summary>Choices for one part or list item: read its text, then each link and button.</summary>
    public static List<PageEntry> BuildControls(string title, string regionId, RegionControls controls, int fieldCount = 0)
    {
        var links = controls.Controls.Count(c => c.Kind == "link");
        var buttons = controls.Controls.Count - links;
        var counts = new List<string>();
        if (links > 0) counts.Add(Count(links, "link"));
        if (buttons > 0) counts.Add(Count(buttons, "button"));
        var summary = counts.Count > 0 ? $"{title}: {string.Join(", ", counts)}. Escape goes back." : $"{title}: no links or buttons. Escape goes back.";
        var entries = new List<PageEntry>
        {
            new(summary, EntryKind.Summary),
            new("Read all text", EntryKind.ReadAll, regionId),
        };
        if (fieldCount > 0) entries.Add(new PageEntry($"Fill in the form, {Count(fieldCount, "field")}", EntryKind.Fields, regionId));
        foreach (var control in controls.Controls)
        {
            var text = control.Kind == "link" ? $"{control.Label}, link" : $"{control.Label}, button";
            if (control.Access == "confirm") text += $", asks first: {control.Note}";
            else if (control.Access == "blocked") text += $", not allowed: {control.Note}";
            entries.Add(new PageEntry(text, EntryKind.Control, control.Id, Control: control));
        }
        if (controls.Truncated) entries.Add(new PageEntry("More links and buttons were left out.", EntryKind.Summary));
        return entries;
    }

    public static string? HiddenReason(OutlineRegion region)
    {
        var noise = region.Noise.FirstOrDefault(HiddenNoise.Contains);
        if (noise is not null) return noise switch
        {
            "ad-frame" or "ad-marker" => "advertisement",
            "sponsored" => "sponsored",
            "cookie-banner" => "cookie banner",
            "offscreen" => "not on screen",
            "link-farm" => "mostly links",
            _ => noise,
        };
        if (region.Kind == "iframe" && string.IsNullOrWhiteSpace(region.Label)) return "unlabelled frame";
        if (region.TextChars == 0 && region.Fields == 0 && region.Buttons == 0 && (region.Items?.Count ?? 0) == 0) return "empty";
        return null;
    }

    private static bool IsSecondary(OutlineRegion region) =>
        SecondaryKinds.Contains(region.Kind) || region.Noise.Any(SecondaryNoise.Contains);

    /// <summary>Label first, so first-letter navigation in the list lands on distinct words.</summary>
    public static string Describe(OutlineRegion region)
    {
        var name = Name(region);
        var parts = new List<string> { name };
        switch (region.Kind)
        {
            case "list":
                var listOf = $"list of {Count(region.Items?.Count ?? 0, "item")}";
                if (name == "List") parts[0] = "L" + listOf[1..]; else parts.Add(listOf);
                break;
            case "section":
                if (region.Level > 0) parts.Add($"level {region.Level}");
                break;
            case "form":
            case "search":
                parts.Add(region.Kind == "search" ? "search" : "form");
                break;
            default:
                if (!name.Equals(KindName(region.Kind), StringComparison.OrdinalIgnoreCase)) parts.Add(KindName(region.Kind).ToLowerInvariant());
                break;
        }
        if (region.Fields > 0) parts.Add(Count(region.Fields, "field"));
        if (region.Noise.Contains("pagination")) parts.Add("page numbers");
        else if (region.Noise.Contains("link-row") && !name.Contains("links", StringComparison.OrdinalIgnoreCase)) parts.Add("links");
        return string.Join(", ", parts);
    }

    public static string Name(OutlineRegion region) =>
        string.IsNullOrWhiteSpace(region.Label) ? KindName(region.Kind) : Shorten(region.Label.Trim(), 80);

    private static string KindName(string kind) => kind switch
    {
        "main" => "Main content",
        "navigation" => "Menu",
        "banner" => "Site header",
        "contentinfo" => "Site footer",
        "complementary" => "Sidebar",
        "search" => "Search",
        "form" => "Form",
        "dialog" => "Dialog",
        "alert" => "Alert",
        "section" => "Section",
        "iframe" => "Embedded frame",
        "overlay" => "Overlay",
        "list" => "List",
        _ => kind,
    };

    private static string Summary(PageOutline outline, int primary, int others, int hidden, bool showHidden, bool hasResults)
    {
        var title = string.IsNullOrWhiteSpace(outline.Title) ? "Untitled page" : outline.Title.Trim();
        var text = $"{Shorten(title, 90)}: {Count(primary, "part")}";
        if (others > 0) text += $", then {others} in sidebars and menus";
        if (hidden > 0) text += showHidden ? $", {hidden} hidden shown" : $", {hidden} hidden";
        if (hasResults) text += ". Results are next";
        return text + ".";
    }

    private static string Count(int n, string noun) => n == 1 ? $"1 {noun}" : $"{n} {noun}s";

    private static string Shorten(string text, int max) => text.Length <= max ? text : text[..max].TrimEnd() + "…";
}
