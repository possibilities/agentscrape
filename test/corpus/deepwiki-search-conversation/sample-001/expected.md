`acme/widget`

### Q: How do I load custom config on startup?

Call `load_config` before the server starts.

```python
load_config("config.yaml")
```

**Citations:**

- [src/config.py:10-18](https://github.com/acme/widget/blob/main/src/config.py#L10-L18) (src/config.py#L10-L18)

---

### Q: Where is the schema validated?

Validation happens in the schema module right after loading.

**Citations:**

- [src/config.py:10-18](https://github.com/acme/widget/blob/main/src/config.py#L10-L18) (src/config.py#L10-L18)
- [src/schema.py:1-4](https://deepwiki.com/acme/widget/blob/main/src/schema.py#L1-L4) (src/schema.py#L1-L4)