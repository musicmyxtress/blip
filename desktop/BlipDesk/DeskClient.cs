using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BlipDesk;

// Talks to the Blip server's desk API on 127.0.0.1:7777.
// The bearer token changes every time Blip starts, so it is re-read from disk before each request.
public sealed class DeskClient : IDisposable
{
    private static readonly string TokenPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BlipDesk", "desk-token");

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly HttpClient _http = new() { BaseAddress = new Uri("http://127.0.0.1:7777/"), Timeout = TimeSpan.FromSeconds(120) };

    public async Task<PageOutline> GetOutlineAsync(CancellationToken cancel = default)
    {
        var response = await SendAsync("desk/outline", cancel);
        return response.Outline ?? throw new DeskException("Blip returned no outline.");
    }

    public async Task<RegionText> ReadRegionAsync(string id, CancellationToken cancel = default)
    {
        var response = await SendAsync($"desk/region?id={Uri.EscapeDataString(id)}", cancel);
        return response.Region ?? throw new DeskException("Blip returned no text for that part of the page.");
    }

    public async Task<RegionControls> GetControlsAsync(string regionId, CancellationToken cancel = default)
    {
        var response = await SendAsync($"desk/controls?id={Uri.EscapeDataString(regionId)}", cancel);
        return response.Controls ?? throw new DeskException("Blip returned no links or buttons.");
    }

    public async Task<ActivateResult> ActivateAsync(string controlId, bool confirmed, CancellationToken cancel = default)
    {
        var body = JsonSerializer.Serialize(new { id = controlId, confirm = confirmed });
        var response = await SendAsync("desk/activate", cancel, HttpMethod.Post, body);
        return response.Activated ?? throw new DeskException("Blip didn't confirm the action.");
    }

    /// <summary>Fields in one part of the page, or on the whole page when regionId is null.</summary>
    public async Task<FieldsResult> GetFieldsAsync(string? regionId, CancellationToken cancel = default)
    {
        var response = await SendAsync($"desk/fields?id={Uri.EscapeDataString(regionId ?? "page")}", cancel);
        return response.Fields ?? throw new DeskException("Blip returned no form fields.");
    }

    /// <summary>Opens a list-style field on the page and returns the choices it shows.</summary>
    public async Task<FieldOptionsResult> GetFieldOptionsAsync(string fieldId, string filter, CancellationToken cancel = default)
    {
        var body = JsonSerializer.Serialize(new { id = fieldId, filter });
        var response = await SendAsync("desk/field-options", cancel, HttpMethod.Post, body);
        return response.Options ?? throw new DeskException("Blip returned no choices.");
    }

    public Task<SetFieldResult> SetFieldTextAsync(string fieldId, string value, CancellationToken cancel = default) =>
        SetFieldAsync(JsonSerializer.Serialize(new { id = fieldId, value }), cancel);

    public Task<SetFieldResult> SetFieldCheckedAsync(string fieldId, bool isChecked, CancellationToken cancel = default) =>
        SetFieldAsync(JsonSerializer.Serialize(new { id = fieldId, @checked = isChecked }), cancel);

    public Task<SetFieldResult> SetFieldOptionAsync(string fieldId, int option, CancellationToken cancel = default) =>
        SetFieldAsync(JsonSerializer.Serialize(new { id = fieldId, option }), cancel);

    private async Task<SetFieldResult> SetFieldAsync(string body, CancellationToken cancel)
    {
        var response = await SendAsync("desk/set-field", cancel, HttpMethod.Post, body);
        return response.Set ?? throw new DeskException("Blip didn't confirm the change.");
    }

    public async Task<AskAnswer> AskAsync(string goal, string question, CancellationToken cancel = default)
    {
        var body = JsonSerializer.Serialize(new { goal, question });
        var response = await SendAsync("desk/ask", cancel, HttpMethod.Post, body);
        return response.Ask ?? throw new DeskException("Claude returned no answer.");
    }

    public async Task<BackResult> BackAsync(CancellationToken cancel = default)
    {
        var response = await SendAsync("desk/back", cancel, HttpMethod.Post, "{}");
        return response.Back ?? throw new DeskException("Blip didn't confirm going back.");
    }

    private async Task<DeskResponse> SendAsync(string path, CancellationToken cancel, HttpMethod? method = null, string? jsonBody = null)
    {
        string token;
        try { token = (await File.ReadAllTextAsync(TokenPath, cancel)).Trim(); }
        catch (FileNotFoundException) { throw new DeskException("Blip isn't running. Start it, then press F5."); }
        catch (DirectoryNotFoundException) { throw new DeskException("Blip isn't running. Start it, then press F5."); }

        using var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (jsonBody is not null) request.Content = new StringContent(jsonBody, System.Text.Encoding.UTF8, "application/json");
        HttpResponseMessage reply;
        try { reply = await _http.SendAsync(request, cancel); }
        catch (HttpRequestException) { throw new DeskException("Blip isn't running. Start it, then press F5."); }
        catch (TaskCanceledException) when (!cancel.IsCancellationRequested) { throw new DeskException("Blip took too long to answer."); }

        using (reply)
        {
            var body = await reply.Content.ReadAsStringAsync(cancel);
            DeskResponse? parsed;
            try { parsed = JsonSerializer.Deserialize<DeskResponse>(body, Json); }
            catch (JsonException) { throw new DeskException($"Blip sent an unreadable answer (status {(int)reply.StatusCode})."); }
            if (parsed is null) throw new DeskException("Blip sent an empty answer.");
            if (!parsed.Ok) throw new DeskException(Explain(parsed.Error, parsed.Message));
            return parsed;
        }
    }

    /// <summary>Turns server error codes into plain sentences for speech.</summary>
    private static string Explain(string? code, string? message) => code switch
    {
        "unauthorized" when message is null => "Blip restarted. Press F5 to try again.",
        "no-extension" => "The Blip extension isn't connected. Check that it is turned on in Chrome.",
        "no-current-tab" => "Blip doesn't know which tab you're on. Switch to a web page tab in Chrome, then press F5.",
        "request-failed" => "The Blip extension didn't answer. If you just updated it, press Reload on chrome://extensions.",
        "restricted-page" => "This page can't be read, for example a Chrome settings page.",
        "stale-page" or "stale-capture" => "The page changed. Press F5 to get a fresh outline.",
        "no-outline" => "Press F5 to get the page outline first.",
        "no-ai" or "ai-failed" or "busy" or "empty-question" => message ?? "Claude isn't available right now.",
        "no-history" => message ?? "There's no earlier page to go back to.",
        "not-found" => message ?? "That part of the page is gone. Press F5 to refresh.",
        "unauthorized" when message is not null => message,
        "invalid-target" => message ?? "That isn't allowed.",
        "exception" when message is not null => message,
        _ => message ?? $"Blip reported a problem: {code ?? "unknown"}.",
    };

    public void Dispose() => _http.Dispose();
}

public sealed class DeskException(string message) : Exception(message);

public sealed class DeskResponse
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? Message { get; set; }
    public PageOutline? Outline { get; set; }
    public RegionText? Region { get; set; }
    public RegionControls? Controls { get; set; }
    public ActivateResult? Activated { get; set; }
    public BackResult? Back { get; set; }
    public AskAnswer? Ask { get; set; }
    public FieldsResult? Fields { get; set; }
    public FieldOptionsResult? Options { get; set; }
    public SetFieldResult? Set { get; set; }
}

public sealed class FieldsResult
{
    public string? Id { get; set; }
    public List<DeskField> Fields { get; set; } = [];
    public List<DeskControl> Controls { get; set; } = [];
    public bool Truncated { get; set; }
}

public sealed class DeskField
{
    public string Id { get; set; } = "";
    /// <summary>text, textarea, select, checkbox, radio, combobox, or other.</summary>
    public string Kind { get; set; } = "";
    public string InputType { get; set; } = "";
    public string Label { get; set; } = "";
    public string? Value { get; set; }
    public bool Sensitive { get; set; }
    public bool Required { get; set; }
    public bool Disabled { get; set; }
    public bool ReadOnly { get; set; }
    public bool? Checked { get; set; }
    public string Invalid { get; set; } = "";
    public string Hint { get; set; } = "";
    public List<FieldOption>? Options { get; set; }
    public int? MaxLength { get; set; }
    /// <summary>For date text boxes: the page's format in fixed tokens, e.g. "MM/DD/YYYY".</summary>
    public string? DateFormat { get; set; }
    /// <summary>page, value, or language (a guess).</summary>
    public string? DateFormatSource { get; set; }
}

public sealed class FieldOption
{
    public string Label { get; set; } = "";
    public bool Selected { get; set; }
}

public sealed class FieldOptionsResult
{
    public string FieldId { get; set; } = "";
    public List<FieldOption> Options { get; set; } = [];
    public bool Truncated { get; set; }
}

public sealed class SetFieldResult
{
    public DeskField Field { get; set; } = new();
    public string Detail { get; set; } = "";
}

public sealed class AskAnswer
{
    public string Answer { get; set; } = "";
    public List<string> RegionIds { get; set; } = [];
    public List<AskAction> Actions { get; set; } = [];
}

public sealed class AskAction
{
    public DeskControl Control { get; set; } = new();
    public string Why { get; set; } = "";
}

public sealed class BackResult
{
    public string Url { get; set; } = "";
    public string Title { get; set; } = "";
}

public sealed class RegionControls
{
    public string Id { get; set; } = "";
    public List<DeskControl> Controls { get; set; } = [];
    public bool Truncated { get; set; }
}

public sealed class DeskControl
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Label { get; set; } = "";
    public string? Host { get; set; }
    /// <summary>direct, confirm, or blocked.</summary>
    public string Access { get; set; } = "";
    public string Note { get; set; } = "";
}

public sealed class ActivateResult
{
    public int TabId { get; set; }
    public string Kind { get; set; } = "";
    public string Status { get; set; } = "";
}

public sealed class PageOutline
{
    public string PageUrl { get; set; } = "";
    public string Title { get; set; } = "";
    public string Status { get; set; } = "";
    public int PageHeight { get; set; }
    public bool Truncated { get; set; }
    public List<OutlineRegion> Regions { get; set; } = [];
    public PageStepsInfo? Steps { get; set; }
}

public sealed class PageStepsInfo
{
    public DeskControl? Next { get; set; }
    public DeskControl? Previous { get; set; }
    public DeskControl? More { get; set; }
}

public sealed class OutlineRegion
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Label { get; set; } = "";
    public int Level { get; set; }
    public string? ParentId { get; set; }
    public RegionRect Rect { get; set; } = new();
    public double ViewportShare { get; set; }
    public int HeadingPx { get; set; }
    public int TextChars { get; set; }
    public int Links { get; set; }
    public int Buttons { get; set; }
    public int Fields { get; set; }
    public int Images { get; set; }
    public List<string> Noise { get; set; } = [];
    public string Preview { get; set; } = "";
    public List<OutlineListItem>? Items { get; set; }
}

public sealed class RegionRect
{
    public int X { get; set; }
    public int Y { get; set; }
    public int W { get; set; }
    public int H { get; set; }
}

public sealed class OutlineListItem
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Preview { get; set; } = "";
}

public sealed class RegionText
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Text { get; set; } = "";
    public bool Truncated { get; set; }
}
