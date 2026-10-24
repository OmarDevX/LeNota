use thiserror::Error;

const MAX_NAME_CHARS: usize = 120;
const MAX_PAGE_TITLE_CHARS: usize = 512;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("name cannot be empty")]
    EmptyName,
    #[error("name cannot exceed {MAX_NAME_CHARS} characters")]
    NameTooLong,
    #[error("page title cannot exceed {MAX_PAGE_TITLE_CHARS} characters")]
    PageTitleTooLong,
}

pub fn validate_name(value: &str) -> Result<&str, ValidationError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ValidationError::EmptyName);
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(ValidationError::NameTooLong);
    }
    Ok(trimmed)
}

pub fn validate_page_title(value: &str) -> Result<&str, ValidationError> {
    let trimmed = value.trim();
    if trimmed.chars().count() > MAX_PAGE_TITLE_CHARS {
        return Err(ValidationError::PageTitleTooLong);
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_valid_names() {
        assert_eq!(validate_name("  Notebook  ").unwrap(), "Notebook");
    }

    #[test]
    fn rejects_empty_names() {
        assert_eq!(validate_name("   "), Err(ValidationError::EmptyName));
    }
}
