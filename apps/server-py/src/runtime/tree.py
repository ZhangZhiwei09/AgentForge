"""ExecutionTree —— 执行节点树工具。

对应 TS: 无独立文件（树操作分布在 controller.ts 的 ExecutionNode 中）。

设计要点：
- 纯函数，不持有状态，输入 ExecutionNode 根节点
- flatten_tree：DFS 展平，用于序列化 / 时间线展示
- find_node：按 ID 查找节点
- walk_tree：通用遍历，传入 visitor 回调
- get_root：从任意节点走到根节点

Python 新概念：
- 递归遍历：Python 默认递归深度 1000，对执行树（通常 < 50 节点）足够
- Generator（yield from）：惰性遍历，避免构建中间 list
"""

from collections.abc import Callable, Iterator
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.runtime.node import ExecutionNode


def flatten_tree(root: "ExecutionNode") -> list["ExecutionNode"]:
    """DFS 前序遍历，将树展平为列表。

    用于序列化、时间线展示、批量状态查询。

    Args:
        root: 执行树根节点

    Returns:
        按 DFS 前序排列的节点列表（root 在 index 0）
    """
    nodes: list[ExecutionNode] = [root]
    for child in root.children:
        nodes.extend(flatten_tree(child))
    return nodes


def iter_tree(root: "ExecutionNode") -> Iterator["ExecutionNode"]:
    """惰性 DFS 前序遍历（Generator）。

    节点数 < 50 时与 flatten_tree 差异可忽略；
    大工作流（100+ 子任务）时节省内存。

    Args:
        root: 执行树根节点

    Yields:
        按 DFS 前序排列的节点
    """
    yield root
    for child in root.children:
        yield from iter_tree(child)


def find_node(root: "ExecutionNode", node_id: str) -> "ExecutionNode | None":
    """按 ID 在树中查找节点。

    Args:
        root: 执行树根节点
        node_id: 目标节点 ID

    Returns:
        找到的节点，未找到返回 None
    """
    if root.id == node_id:
        return root
    for child in root.children:
        result = find_node(child, node_id)
        if result is not None:
            return result
    return None


def get_root(node: "ExecutionNode") -> "ExecutionNode":
    """从任意节点向上走到根节点。

    Args:
        node: 当前节点

    Returns:
        根节点（parent 为 None 的节点）
    """
    current = node
    while current.parent is not None:
        current = current.parent
    return current


def get_depth(node: "ExecutionNode") -> int:
    """获取节点在树中的深度（根节点深度 = 0）。

    Args:
        node: 当前节点

    Returns:
        深度值
    """
    depth = 0
    current = node
    while current.parent is not None:
        depth += 1
        current = current.parent
    return depth


def count_nodes(root: "ExecutionNode") -> int:
    """递归统计树中节点总数。

    Args:
        root: 执行树根节点

    Returns:
        节点总数（含 root）
    """
    count = 1
    for child in root.children:
        count += count_nodes(child)
    return count


def get_terminal_nodes(root: "ExecutionNode") -> list["ExecutionNode"]:
    """获取树中所有终端态节点。

    Args:
        root: 执行树根节点

    Returns:
        终端态节点列表
    """
    return [n for n in flatten_tree(root) if n.is_terminal]


def get_active_nodes(root: "ExecutionNode") -> list["ExecutionNode"]:
    """获取树中所有活跃节点（非终端态）。

    Args:
        root: 执行树根节点

    Returns:
        活跃节点列表
    """
    return [n for n in flatten_tree(root) if not n.is_terminal]


def get_duration_tree(root: "ExecutionNode") -> dict:
    """获取节点树的耗时摘要。

    Args:
        root: 执行树根节点

    Returns:
        嵌套 dict: {id, type, state, duration_ms, children: [...]}
    """
    return {
        "id": root.id,
        "type": root.type,
        "state": root.state.value,
        "duration_ms": round(root.duration * 1000, 2),
        "children": [get_duration_tree(child) for child in root.children],
    }


def walk_tree(
    root: "ExecutionNode",
    visitor: Callable[["ExecutionNode"], None],
) -> None:
    """通用树遍历：对每个节点调用 visitor。

    Args:
        root: 执行树根节点
        visitor: 回调函数，接收每个节点（含 root）
    """
    visitor(root)
    for child in root.children:
        walk_tree(child, visitor)
