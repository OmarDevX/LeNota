//! Mobile Gemini transport. No subprocesses or Python runtime are used.
//! Prompts mirror the existing desktop worker; user keys stay in app storage.
use crate::commands::CommandError;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, CommandError>;
static COOLDOWNS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Instant>>> = std::sync::OnceLock::new();
fn cooling_down(provider: &str) -> bool {
    COOLDOWNS.get_or_init(Default::default).lock().ok()
        .and_then(|map| map.get(provider).copied()).is_some_and(|until| until > Instant::now())
}
fn clear_cooldown(provider: &str) {
    if let Ok(mut map) = COOLDOWNS.get_or_init(Default::default).lock() { map.remove(provider); }
}
fn cool_down(provider: &str) {
    if let Ok(mut map) = COOLDOWNS.get_or_init(Default::default).lock() {
        map.insert(provider.to_string(), Instant::now() + Duration::from_secs(60));
    }
}

pub(crate) fn request(mut request: Value) -> Result<Value> {
    // The OpenAI Images API integration is currently desktop-only.
    // Never silently turn an image request into a Gemini text description.
    if field(&request, "op").starts_with("cloud_ask")
        && field(&request, "prompt").trim_start().to_ascii_lowercase().starts_with("/image ") {
        return Err(failure("PNG image generation is currently desktop-only and requires a separately billed OpenAI Images API key. Mobile still supports text /ask and SVG diagrams."));
    }
    let backups = request.get("backups").cloned().unwrap_or_default();
    let has_backup = !field(&backups, "openrouter").is_empty();
    if !has_backup { return request_gemini(request); }
    let full_timeout = request["timeout_seconds"].as_f64().unwrap_or(80.).clamp(2., 100.);
    request["timeout_seconds"] = json!(full_timeout.min(15.));
    if !field(&request, "api_key").is_empty() && !cooling_down("gemini") {
        if let Ok(value) = request_gemini(request.clone()) { return Ok(value); }
        cool_down("gemini");
    }
    let templates: Value = serde_json::from_str(include_str!("mobile-ai-prompts.json"))
        .map_err(|_| failure("AI prompts could not be loaded."))?;
    let parts = request_parts(&request, &templates)?;
    let images: Vec<_> = parts.iter().filter_map(|part| part["inlineData"]["data"].as_str()).collect();
    let text = parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n");
    let client = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| failure("Unable to initialize AI network client."))?;
    let deadline = Instant::now() + Duration::from_secs_f64((full_timeout - 15.).max(2.));
    let mut errors = Vec::new();
    let models: &[&str] = if images.is_empty() {
        &["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-super-120b-a12b:free"]
    } else { &["qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free"] };
    for (index, model) in models.iter().enumerate() {
        let provider = "openrouter";
        let key = field(&backups, provider);
        let selected_test = field(&request,"test_provider");
        if key.is_empty() || (!selected_test.is_empty() && selected_test != provider)
           || (index == 0 && selected_test.is_empty() && cooling_down(provider)) { continue; }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining < Duration::from_secs(1) { break; }
        let prompt = text.clone();
        let endpoint = "https://openrouter.ai/api/v1/chat/completions";
        let mut result: Result<Value> = Err(failure("AI provider did not complete a request."));
        for attempt in 0..2 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining < Duration::from_secs(2) { break; }
            let retry = if attempt == 0 { "" } else { "\nIMPORTANT: Previous reply ran out of output tokens. Give a shorter COMPLETE response without extended reasoning." };
            let prompt = format!("{prompt}{retry}");
            let content = if images.is_empty() { json!(prompt) } else {
                let mut content = vec![json!({"type":"text","text":prompt})];
                content.extend(images.iter().map(|image| json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{image}")}})));
                json!(content)
            };
            let mut payload = json!({"model":model,"messages":[{"role":"user","content":content}],
                "max_tokens":8192,"stream":false});
            // Never allow OpenRouter to charge for a paid model.
            payload["provider"] = json!({"max_price":{"prompt":0,"completion":0}});
            payload["reasoning"] = json!({"effort":"low"});
            let response_result = (|| -> Result<(Value,bool)> {
                let response = client.post(endpoint).bearer_auth(key).timeout(remaining.min(Duration::from_secs(25)))
                    .json(&payload).send().map_err(|_| failure(format!("{provider}: network request failed")))?;
                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let hint = match status {401=>"invalid or expired API key",402=>"account or credits required",
                        403=>"account, region or model access denied",429=>"rate limit or free quota",
                        404=>"model or free route unavailable",_=>"provider request failed"};
                    return Err(failure(format!("{provider}: HTTP {status} ({hint})")));
                }
                let mut bytes = Vec::new();
                response.take(2_000_001).read_to_end(&mut bytes).map_err(|_| failure("Unable to read backup AI response."))?;
                if bytes.len() > 2_000_000 { return Err(failure("Backup AI response exceeded 2 MB.")); }
                let envelope: Value = serde_json::from_slice(&bytes).map_err(|_| failure("Backup AI returned invalid JSON envelope."))?;
                let choice = &envelope["choices"][0];
                if choice["finish_reason"] != "stop" {
                    let length = ["length","max_tokens"].contains(&field(choice,"finish_reason"));
                    return Ok((json!({"error": "Backup AI returned an incomplete or blocked response.", "length":length}),true));
                }
                let content = choice["message"]["content"].as_str().map(str::to_owned).or_else(|| {
                    choice["message"]["content"].as_array().map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""))
                }).unwrap_or_default();
                let value = decode_backup_content(&content, ["cloud_ask", "cloud_ask_selection"].contains(&field(&request,"op")))?;
                let engine = format!("{} · {}", "OpenRouter Free", field(&envelope,"model").chars().take(120).collect::<String>());
                Ok((normalize_response(value, field(&request,"op"), field(&request,"mode"), &engine)?,false))
            })();
            match response_result {
                Ok((value,true)) if attempt == 0 && value["length"] == true => { continue; }
                Ok((value,true)) => { result = Err(failure(field(&value,"error"))); break; }
                Ok((value,false)) => { result = Ok(value); break; }
                Err(error) => { result = Err(error); break; }
            }
        }
        match result { Ok(value) => { clear_cooldown(provider); return Ok(value); }, Err(error) => { errors.push(error.message); if index + 1 == models.len() { cool_down(provider); } } }
    }
    Err(failure(if errors.is_empty() { "AI backups are cooling down or unavailable for this request. Retry in a minute.".into() } else { errors.join(" | ") }))
}
fn decode_backup_content(text: &str, allow_plaintext: bool) -> Result<Value> {
    let mut trimmed = text.trim();
    if trimmed.starts_with("```") {
        trimmed = trimmed.strip_prefix("```json").or_else(|| trimmed.strip_prefix("```")).unwrap_or(trimmed).trim();
        trimmed = trimmed.strip_suffix("```").unwrap_or(trimmed).trim();
    }
    if trimmed.is_empty() { return Err(failure("Backup AI returned an empty answer.")); }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) { return Ok(value); }
    if !allow_plaintext || trimmed.len() > 32_000 || trimmed.starts_with('{') || trimmed.starts_with('[') {
        return Err(failure("Backup AI returned invalid structured JSON."));
    }
    let blocks: Vec<Value> = trimmed.split("\n\n").map(str::trim).filter(|part| !part.is_empty()).take(50)
        .map(|part| json!({"type":"paragraph","text":part})).collect();
    if blocks.is_empty() { return Err(failure("Backup AI returned an empty answer.")); }
    Ok(json!({"blocks":blocks}))
}

fn failure(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "cloud_ai_failed",
        message: message.into(),
    }
}
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}
fn clean_latex(value: &str) -> String {
    let mut text = value.trim();
    for (left, right) in [("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"), ("$", "$")] {
        if text.starts_with(left) && text.ends_with(right) && text.len() >= left.len() + right.len()
        {
            text = &text[left.len()..text.len() - right.len()];
            break;
        }
    }
    text.trim().to_string()
}

fn normalize_response(mut value: Value, op: &str, mode: &str, engine: &str) -> Result<Value> {
    match op {
        "cloud_ink" => {
            let kind = if mode == "auto" {
                field(&value, "kind")
            } else {
                mode
            };
            let key = if kind == "math" {
                "latex"
            } else if kind == "text" {
                "text"
            } else {
                return Err(failure("Gemini did not classify the handwriting."));
            };
            let text = field(&value, key).trim();
            if text.is_empty() || text.len() > 32_000 {
                return Err(failure("Gemini returned an invalid transcription."));
            }
            Ok(
                json!({"kind":kind, key:if key == "latex" { clean_latex(text) } else {text.to_string()}, "engine":engine}),
            )
        }
        "cloud_math_solve" => {
            let status = field(&value, "status");
            if !["solved", "identity", "relation", "not_solvable"].contains(&status) {
                return Err(failure("Gemini returned an invalid math result."));
            }
            let result = if status == "not_solvable" {
                String::new()
            } else {
                clean_latex(field(&value, "result_latex"))
            };
            if status != "not_solvable" && (result.is_empty() || result.len() > 12_000) {
                return Err(failure(
                    "Gemini returned an empty or oversized math result.",
                ));
            }
            let graph = value.get("graph").filter(|graph| graph.is_object()).and_then(|graph| {
                let relation = clean_latex(field(graph, "relation_latex"));
                if relation.matches('=').count() != 1 || relation.len() > 2_000 { return None; }
                let number = |name| graph.get(name).and_then(Value::as_f64);
                let (mut xmin, mut xmax, mut ymin, mut ymax) = (number("x_min").unwrap_or(-10.), number("x_max").unwrap_or(10.), number("y_min").unwrap_or(-10.), number("y_max").unwrap_or(10.));
                if xmin >= xmax || ymin >= ymax || [xmin,xmax,ymin,ymax].iter().any(|n| !n.is_finite() || n.abs() > 1_000_000.) { (xmin,xmax,ymin,ymax)=(-10.,10.,-10.,10.); }
                Some(json!({"relationLatex":relation,"xMin":xmin,"xMax":xmax,"yMin":ymin,"yMax":ymax,"title":field(graph,"title").chars().take(180).collect::<String>()}))
            });
            Ok(json!({"status":status,"resultLatex":result,"graph":graph,"engine":engine}))
        }
        "cloud_ask" | "cloud_ask_selection" => {
            let blocks = value
                .get("blocks")
                .and_then(Value::as_array)
                .ok_or_else(|| failure("Gemini returned invalid note content."))?;
            if blocks.is_empty() || blocks.len() > 1_000 {
                return Err(failure("Gemini returned empty or oversized note content."));
            }
            value["engine"] = json!(engine);
            Ok(value)
        }
        _ => Err(failure("Unknown Gemini request.")),
    }
}

fn request_parts(request: &Value, templates: &Value) -> Result<Vec<Value>> {
    let op = field(request, "op");
    let mode = field(request, "mode");
    let name = match op {
        "cloud_ink" => format!("ink_{mode}"),
        "cloud_math_solve" => if request["force_graph"].as_bool().unwrap_or(false) {
            "graph"
        } else {
            "math"
        }
        .into(),
        "cloud_ask_selection" => "ask_selection".into(),
        "cloud_ask" => "ask".into(),
        _ => return Err(failure("Unknown Gemini request.")),
    };
    let template = templates
        .get(&name)
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Unknown recognition mode."))?;
    // Replace placeholders in one pass; user-provided context must never be
    // scanned again and accidentally expanded as another template placeholder.
    let replacements = [
        ("__LN_PROMPT__", field(request, "prompt")),
        ("__LN_CONTEXT__", field(request, "page_context")),
        ("__LN_LATEX__", field(request, "latex")),
        ("__LN_LANGUAGE__", field(request, "language")),
        ("__LN_HINT__", field(request, "hint")),
    ];
    let mut prompt = String::new();
    let mut remaining = template;
    while !remaining.is_empty() {
        let next = replacements
            .iter()
            .filter_map(|(token, text)| {
                remaining
                    .find(token)
                    .map(|position| (position, *token, *text))
            })
            .min_by_key(|entry| entry.0);
        if let Some((position, token, text)) = next {
            prompt.push_str(&remaining[..position]);
            prompt.push_str(text);
            remaining = &remaining[position + token.len()..];
        } else {
            prompt.push_str(remaining);
            break;
        }
    }
    let mut parts = vec![json!({"text":prompt})];
    if let Some(path) = request.get("path").and_then(Value::as_str) {
        let image = fs::read(path).map_err(|_| failure("The selected image could not be read."))?;
        if image.len() > 10_000_000 {
            return Err(failure("Cloud images are limited to 10 MB."));
        }
        parts.push(json!({"inlineData":{"mimeType":"image/png","data":STANDARD.encode(image)}}));
    }
    Ok(parts)
}

fn request_gemini(request: Value) -> Result<Value> {
    let templates: Value = serde_json::from_str(include_str!("mobile-ai-prompts.json"))
        .map_err(|_| failure("Mobile AI prompts could not be loaded."))?;
    let op = field(&request, "op");
    let mode = field(&request, "mode");
    let parts = request_parts(&request, &templates)?;
    let timeout = request["timeout_seconds"]
        .as_f64()
        .unwrap_or(30.)
        .clamp(2., if op.starts_with("cloud_ask") {100.} else {60.});
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| failure("Unable to initialize the mobile network client."))?;
    let models = templates[if op == "cloud_ink" {
        "ink_models"
    } else {
        "models"
    }]
    .as_array()
    .ok_or_else(|| failure("No Gemini models configured."))?;
    let tokens = if op == "cloud_ink" {
        2048
    } else if op == "cloud_math_solve" {
        4096
    } else {
        8192
    };
    let mut last_error = "No Gemini model responded.".to_string();
    for model in models.iter().filter_map(Value::as_str) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining < Duration::from_millis(500) {
            break;
        }
        let response = client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
            .header("x-goog-api-key", field(&request,"api_key"))
            .timeout(remaining.min(Duration::from_secs(if op == "cloud_ink" {5} else {25})))
            .json(&json!({"contents":[{"role":"user","parts":parts}],"generationConfig":{"temperature":0.1,"maxOutputTokens":tokens,"responseMimeType":"application/json"}})).send();
        let response = match response {
            Ok(response) => response,
            Err(_) => {
                last_error = "Unable to reach Gemini. Check your internet connection.".into();
                continue;
            }
        };
        let status = response.status().as_u16();
        if status != 200 {
            last_error = format!(
                "Gemini returned HTTP {status}. Check your API key, quota, and model access."
            );
            if status == 401 || status == 403 {
                return Err(failure(last_error));
            }
            continue;
        }
        let mut bytes = Vec::new();
        response
            .take(2_000_001)
            .read_to_end(&mut bytes)
            .map_err(|_| failure("Unable to read the Gemini response."))?;
        if bytes.len() > 2_000_000 {
            return Err(failure("Gemini response exceeded the 2 MB limit."));
        }
        let envelope: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                last_error = "Gemini returned an invalid response.".into();
                continue;
            }
        };
        let candidate = &envelope["candidates"][0];
        if candidate["finishReason"].as_str().is_some_and(|reason| reason != "STOP") {
            last_error = "Gemini response was incomplete or blocked. Try a shorter request.".into();
            continue;
        }
        let output = candidate["content"]["parts"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|part| part["thought"] != true)
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default();
        let text = output
            .trim()
            .strip_prefix("```json")
            .or_else(|| output.trim().strip_prefix("```"))
            .unwrap_or(output.trim())
            .trim()
            .trim_end_matches("```")
            .trim();
        let value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(_) => {
                last_error = "Gemini returned invalid JSON. Try again.".into();
                continue;
            }
        };
        match normalize_response(value, op, mode, model) {
            Ok(result) => return Ok(result),
            Err(error) => last_error = error.message,
        }
    }
    Err(failure(last_error))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn math_uses_frontend_casing_and_checks_ranges() {
        let value=normalize_response(json!({"status":"solved","result_latex":"$$x=2$$","graph":{"relation_latex":"y=x^2","x_min":5,"x_max":1}}),"cloud_math_solve","","test").unwrap();
        assert_eq!(value["resultLatex"], "x=2");
        assert_eq!(value["graph"]["xMin"], -10.);
    }
    #[test]
    fn recognition_rejects_empty_text() {
        assert!(
            normalize_response(
                json!({"kind":"text","text":""}),
                "cloud_ink",
                "auto",
                "test"
            )
            .is_err()
        );
    }
}
