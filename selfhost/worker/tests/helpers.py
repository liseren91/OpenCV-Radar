REQUIRED_FIELDS = {
    "id", "title", "company", "location", "remote", "office", "relocate",
    "url", "source", "posted_at", "salary", "description", "tags",
}


def assert_valid_jobs(jobs, source_name=None):
    """Assert a source returned a list of schema-complete job dicts."""
    assert isinstance(jobs, list)
    for j in jobs:
        assert REQUIRED_FIELDS <= set(j), f"missing {REQUIRED_FIELDS - set(j)} in {j!r}"
        assert isinstance(j["title"], str) and j["title"]
        assert isinstance(j["url"], str) and j["url"].startswith("http")
        assert isinstance(j["remote"], bool)
        assert isinstance(j["office"], bool)
        assert isinstance(j["relocate"], bool)
        assert isinstance(j["tags"], list)
        assert j["posted_at"] is None or len(j["posted_at"]) == 10
        # salary is a structured dict or None — never a raw string.
        assert j["salary"] is None or isinstance(j["salary"], dict), f"salary not dict/None: {j['salary']!r}"
        if isinstance(j["salary"], dict):
            assert {"min", "max", "currency"} <= set(j["salary"])
        if source_name:
            assert j["source"] == source_name
