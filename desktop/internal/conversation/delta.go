package conversation

import (
	"encoding/json"
	"fmt"
	"unicode/utf16"
)

// ApplyOps 把 Chord delta ops（chord/delta 的 Op：r s d a t p m）应用到一个已解码的 JSON 树上，并返回新的
// 根。容器都是就地修改；只有 "r" 会换掉根。语义与 chord 的 applyImmutableTrusted 保持一致；"t" 按 JavaScript
// 的 String.prototype.slice 那样，丢掉开头 n 个 UTF-16 code unit。畸形的 op 会返回错误，绝不 panic；但此时树
// 可能已被部分修改，所以调用方必须重新订阅。
func ApplyOps(root any, ops []json.RawMessage) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			result, err = root, fmt.Errorf("malformed op: %v", r)
		}
	}()
	for _, raw := range ops {
		var op []any
		if err := json.Unmarshal(raw, &op); err != nil {
			return root, err
		}
		if len(op) == 0 {
			return root, fmt.Errorf("empty op")
		}
		kind, _ := op[0].(string)
		if kind == "r" {
			root = op[1]
			continue
		}
		path, ok := op[1].([]any)
		if !ok {
			return root, fmt.Errorf("op %s: path is %T", kind, op[1])
		}
		if kind == "p" || kind == "m" {
			target, err := walk(root, path)
			if err != nil {
				return root, err
			}
			arr, ok := target.([]any)
			if !ok {
				return root, fmt.Errorf("op %s: target is %T", kind, target)
			}
			var next []any
			if kind == "p" {
				start, remove := int(op[2].(float64)), int(op[3].(float64))
				items, _ := op[4].([]any)
				next = append(append(append([]any{}, arr[:start]...), items...), arr[start+remove:]...)
			} else {
				perm := op[2].([]any)
				next = make([]any, len(perm))
				for i, p := range perm {
					next[i] = arr[int(p.(float64))]
				}
			}
			root, err = replaceAt(root, path, next)
			if err != nil {
				return root, err
			}
			continue
		}
		parent, err := walk(root, path[:len(path)-1])
		if err != nil {
			return root, err
		}
		key := path[len(path)-1]
		switch kind {
		case "s":
			root, err = setChild(root, path, parent, key, op[2])
		case "d":
			switch p := parent.(type) {
			case map[string]any:
				delete(p, key.(string))
			case []any:
				i := int(key.(float64))
				root, err = replaceAt(root, path[:len(path)-1], append(append([]any{}, p[:i]...), p[i+1:]...))
			}
		case "a", "t":
			current, _ := getChild(parent, key).(string)
			var value string
			if kind == "a" {
				value = current + op[2].(string)
			} else {
				value = string(utf16.Decode(utf16.Encode([]rune(current))[int(op[2].(float64)):]))
			}
			root, err = setChild(root, path, parent, key, value)
		default:
			err = fmt.Errorf("unknown op %q", kind)
		}
		if err != nil {
			return root, err
		}
	}
	return root, nil
}

func walk(root any, path []any) (any, error) {
	node := root
	for _, seg := range path {
		next := getChild(node, seg)
		if next == nil {
			return nil, fmt.Errorf("path %v: missing %v", path, seg)
		}
		node = next
	}
	return node, nil
}

func getChild(node any, seg any) any {
	switch n := node.(type) {
	case map[string]any:
		if k, ok := seg.(string); ok {
			return n[k]
		}
	case []any:
		if f, ok := seg.(float64); ok && int(f) < len(n) {
			return n[int(f)]
		}
	}
	return nil
}

// setChild 设置 parent[key] = value；在下标等于长度处设置 slice 相当于追加，这时需要在它自己的父节点里替换
// 这个 slice。
func setChild(root any, path []any, parent any, key any, value any) (any, error) {
	switch p := parent.(type) {
	case map[string]any:
		p[key.(string)] = value
		return root, nil
	case []any:
		i := int(key.(float64))
		if i < len(p) {
			p[i] = value
			return root, nil
		}
		return replaceAt(root, path[:len(path)-1], append(p, value))
	}
	return root, fmt.Errorf("set %v: parent is %T", path, parent)
}

// replaceAt 把 value 放到 path 处（变长或变短的 slice 需要更新它的父节点）。
func replaceAt(root any, path []any, value any) (any, error) {
	if len(path) == 0 {
		return value, nil
	}
	parent, err := walk(root, path[:len(path)-1])
	if err != nil {
		return root, err
	}
	return setChild(root, path, parent, path[len(path)-1], value)
}
