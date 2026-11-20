namespace BlipDesk;

public enum EntryKind { Summary, Region, Item, ReadAll, Control }

/// <summary>One line in the Page list.</summary>
public sealed record PageEntry(string Text, EntryKind Kind, string? Id = null, OutlineRegion? Region = null, DeskControl? Control = null, bool Hidden = false)
{
    public bool IsList => Region is { Kind: "list", Items.Count: > 0 };
    public override string ToString() => Text;
}

/// <summary>
/// Turns a raw outline into the list a screen reader user hears: real content first in page order,
/// menus and page numbers after it, and noise hidden unless asked for.
/// </summary>
public static class PageView
{
    private static readonly HashSet<string> HiddenNoise = ["ad-frame", "ad-marker", "sponsored", "cookie-banner", "offscreen", "link-farm"];
    private static readonly HashSet<string> SecondaryNoise = ["link-row", "pagination"];
    private static readonly HashSet<string> SecondaryKinds = ["navigation", "banner", "contentinfo"];

    public static List<PageEntry> Build(PageOutline outline, bool showHidden)
    {
        var primary = new List<PageEntry>();
        var secondary = new List<PageEntry>();
        var hidden = new List<PageEntry>();

        foreach (var region in outline.Regions.OrderBy(r => r.Rect.Y).ThenBy(r => r.Rect.X))
        {
            var reason = HiddenReason(region);
            if (reason is not null)
            {
                hidden.Add(new PageEntry($"{Describe(region)}, hidden: {reason}", EntryKind.Region, region.Id, region, Hidden: true));
                continue;
            }
            var entry = new PageEntry(Describe(region), EntryKind.Region, region.Id, region);
            if (IsSecondary(region)) secondary.Add(entry); else primary.Add(entry);
        }

        var summary = Summary(outline, primary.Count, secondary.Count, hidden.Count, showHidden);
        var entries = new List<PageEntry> { new(summary, EntryKind.Summary) };
        entries.AddRange(primary);
        entries.AddRange(secondary);
        if (showHidden) entries.AddRange(hidden);
        return entries;
    }

    /// <summary>Entries for the items inside one list region, led by a summary line.</summary>
    public static List<PageEntry> BuildItems(OutlineRegion list)
    {
        var items = list.Items ?? [];
        var entries = new List<PageEntry>
        {
            new($"{Name(list)}: {Count(items.Count, "item")}. Enter for choices, Control Enter opens it, Escape goes back.", EntryKind.Summary),
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
    public static List<PageEntry> BuildControls(string title, string regionId, RegionControls controls)
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
        string.IsNullOrWhiteSpace(region.Label) ? KindName(region.Kind) : region.Label.Trim();

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

    private static string Summary(PageOutline outline, int primary, int secondary, int hidden, bool showHidden)
    {
        var title = string.IsNullOrWhiteSpace(outline.Title) ? "Untitled page" : outline.Title.Trim();
        var text = $"{Shorten(title, 90)}: {Count(primary, "part")}";
        if (secondary > 0) text += $", then {Count(secondary, "menu")}";
        if (hidden > 0) text += showHidden ? $", {hidden} hidden shown" : $", {hidden} hidden";
        return text + ".";
    }

    private static string Count(int n, string noun) => n == 1 ? $"1 {noun}" : $"{n} {noun}s";

    private static string Shorten(string text, int max) => text.Length <= max ? text : text[..max].TrimEnd() + "…";
}
