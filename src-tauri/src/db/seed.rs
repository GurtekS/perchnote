use anyhow::Result;
use super::Database;

pub fn seed_templates(db: &Database) -> Result<()> {
    let conn = db.conn.lock().unwrap();

    // Check if already seeded
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM templates WHERE is_builtin = 1",
        [],
        |row| row.get(0),
    )?;
    if count > 0 {
        return Ok(());
    }
    drop(conn);

    let templates = vec![
        (
            "General Meeting",
            "Default template for any meeting type",
            r#"You are a meeting notes assistant. Given the transcript and user notes from a meeting, generate structured notes.

Meeting: {{title}}
Date: {{date}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

## User's rough notes:
{{notes}}

Generate structured meeting notes with these sections: {{sections}}

For action items, identify the assignee and any mentioned deadlines. Return 2-3 categorization tags for this meeting."#,
            r#"["Summary","Key Points","Decisions","Action Items"]"#,
            true, // is_default
        ),
        (
            "Standup",
            "Daily standup / scrum meeting format",
            r#"You are a meeting notes assistant for a daily standup. Given the transcript and user notes, generate structured standup notes per person.

Meeting: {{title}}
Date: {{date}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

## User's rough notes:
{{notes}}

Generate structured standup notes with these sections per person: {{sections}}

Return 2-3 categorization tags for this meeting."#,
            r#"["What I Did","What I'm Doing","Blockers"]"#,
            false,
        ),
        (
            "1:1",
            "One-on-one meeting between two people",
            r#"You are a meeting notes assistant for a 1:1 meeting. Given the transcript and user notes, generate structured notes.

Meeting: {{title}}
Date: {{date}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

## User's rough notes:
{{notes}}

Generate structured 1:1 meeting notes with these sections: {{sections}}

Return 2-3 categorization tags for this meeting."#,
            r#"["Discussion Topics","Feedback","Action Items","Follow-ups"]"#,
            false,
        ),
        (
            "Sales Call",
            "Sales or business development call",
            r#"You are a meeting notes assistant for a sales call. Given the transcript and user notes, generate structured notes focused on the sales opportunity.

Meeting: {{title}}
Date: {{date}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

## User's rough notes:
{{notes}}

Generate structured sales call notes with these sections: {{sections}}

Return 2-3 categorization tags for this meeting."#,
            r#"["Prospect Info","Pain Points","Objections","Budget/Timeline","Next Steps"]"#,
            false,
        ),
        (
            "User Interview",
            "User research or customer interview",
            r#"You are a meeting notes assistant for a user interview. Given the transcript and user notes, generate structured research notes. Include direct quotes where insightful.

Meeting: {{title}}
Date: {{date}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

## User's rough notes:
{{notes}}

Generate structured user interview notes with these sections: {{sections}}

Return 2-3 categorization tags for this meeting."#,
            r#"["Background","Key Insights","Pain Points","Feature Requests","Quotes"]"#,
            false,
        ),
        (
            "Brainstorm",
            "Brainstorming or ideation session",
            r#"You are a meeting notes assistant for a brainstorming session. Given the transcript and user notes, organize the ideas generated.

Meeting: {{title}}
Date: {{date}}
Attendees: {{attendees}}

## Transcript:
{{transcript}}

## User's rough notes:
{{notes}}

Generate structured brainstorming notes with these sections: {{sections}}

Return 2-3 categorization tags for this meeting."#,
            r#"["Ideas Generated","Themes","Top Picks","Next Steps"]"#,
            false,
        ),
    ];

    for (name, desc, prompt, sections, is_default) in templates {
        db.create_template(name, Some(desc), prompt, sections, is_default, true)?;
    }

    Ok(())
}
