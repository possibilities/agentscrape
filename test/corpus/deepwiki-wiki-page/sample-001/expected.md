# Configuration Loading

`acme/widget`

The loader reads `config.yaml` before falling back to defaults.[1](https://deepwiki.com/acme/widget/2-configuration#cite-1)

## Example

```python
def load_config(path):
    return yaml.safe_load(open(path))
```

See the [configuration reference](https://deepwiki.com/acme/widget/2-configuration) for every key, and the schema module.[2](https://deepwiki.com/acme/widget/2-configuration#cite-2)

## Citations

- [src/config.py:10-18](https://github.com/acme/widget/blob/main/src/config.py#L10-L18) (src/config.py#L10-L18)
- [src/schema.py:1-4](https://deepwiki.com/acme/widget/blob/main/src/schema.py#L1-L4) (src/schema.py#L1-L4)