import uuid


async def test_create_comment(client, post):
    response = await client.post(
        f"/api/v1/posts/{post['id']}/comments",
        json={"content": "Nice post!", "author": "commenter"},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["content"] == "Nice post!"
    assert data["author"] == "commenter"
    assert data["post_id"] == post["id"]
    assert "id" in data
    assert "created_at" in data


async def test_create_comment_post_not_found(client):
    fake_id = str(uuid.uuid4())
    response = await client.post(
        f"/api/v1/posts/{fake_id}/comments",
        json={"content": "Hello", "author": "commenter"},
    )
    assert response.status_code == 404


async def test_list_comments(client, post):
    for i in range(3):
        await client.post(
            f"/api/v1/posts/{post['id']}/comments",
            json={"content": f"Comment {i}", "author": "commenter"},
        )

    response = await client.get(
        f"/api/v1/posts/{post['id']}/comments?page=1&size=2"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 2
    assert data["total"] == 3
    assert data["page"] == 1
    assert data["size"] == 2

    response = await client.get(
        f"/api/v1/posts/{post['id']}/comments?page=2&size=2"
    )
    data = response.json()
    assert len(data["items"]) == 1


async def test_delete_comment(client, post):
    resp = await client.post(
        f"/api/v1/posts/{post['id']}/comments",
        json={"content": "Delete me", "author": "commenter"},
    )
    comment_id = resp.json()["id"]

    response = await client.delete(f"/api/v1/comments/{comment_id}")
    assert response.status_code == 204

    list_resp = await client.get(f"/api/v1/posts/{post['id']}/comments")
    assert list_resp.json()["total"] == 0


async def test_delete_comment_not_found(client):
    fake_id = str(uuid.uuid4())
    response = await client.delete(f"/api/v1/comments/{fake_id}")
    assert response.status_code == 404
