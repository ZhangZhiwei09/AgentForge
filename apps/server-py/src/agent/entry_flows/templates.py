def empty_entry_template() -> dict:
    return {
        "schemaVersion": 1,
        "nodes": [
            {"id": "start", "name": "开始", "type": "start", "position": {"x": 0, "y": 100}},
            {"id": "fallback", "name": "继续智能路由", "type": "continue", "position": {"x": 280, "y": 100}},
        ],
        "edges": [{"id": "start_fallback", "source": "start", "target": "fallback", "branch": None}],
    }


def default_entry_template() -> dict:
    rules = [
        ("greeting", "问候", ["你好", "hi", "hello", "嗨", "您好", "早上好", "下午好", "晚上好", "在吗", "在不在"],
         "你好，我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。需要什么帮助？", ["查询知识库", "诊断系统故障"]),
        ("thanks", "感谢", ["谢谢", "感谢", "多谢", "谢谢你", "谢谢您", "thanks", "thank you", "3q"],
         "不客气。还有其他问题可以随时找我。", []),
        ("farewell", "告别", ["再见", "拜拜", "bye", "88", "下次见", "回头见"], "再见。", []),
        ("human", "转人工", ["转人工", "找人工", "找真人", "找客服", "我要投诉"], None, []),
        ("diagnosis", "故障诊断", ["traceId:", "traceId：", "error_code:", "报错", "失败", "超时", "打不开", "连不上", "崩溃", "闪退", "白屏", "卡死"], None, []),
    ]
    nodes = [{"id": "start", "name": "开始", "type": "start", "position": {"x": 0, "y": 280}}]
    edges = [{"id": "start_first", "source": "start", "target": rules[0][0], "branch": None}]
    for index, (node_id, name, words, answer, suggestions) in enumerate(rules):
        x = 270 + index * 270
        nodes.append({
            "id": node_id, "name": name, "type": "condition", "position": {"x": x, "y": 280},
            "condition": {"operator": "equals_any" if answer else "contains_any", "words": words,
                          "excludeAny": [], "ignoreCase": True, "stripTrailingPunctuation": answer is not None},
        })
        result = {"id": f"{node_id}_result", "name": f"{name}回复" if answer else name, "position": {"x": x, "y": 40}}
        result.update({"type": "reply", "answer": answer, "suggestions": suggestions} if answer else
                      {"type": "route", "target": "HUMAN" if node_id == "human" else "DIAGNOSIS"})
        nodes.append(result)
        edges.extend([
            {"id": f"{node_id}_hit", "source": node_id, "target": result["id"], "branch": "true"},
            {"id": f"{node_id}_miss", "source": node_id, "target": rules[index + 1][0] if index + 1 < len(rules) else "fallback", "branch": "false"},
        ])
    nodes.append({"id": "fallback", "name": "继续智能路由", "type": "continue", "position": {"x": 1620, "y": 280}})
    return {"schemaVersion": 1, "nodes": nodes, "edges": edges}
