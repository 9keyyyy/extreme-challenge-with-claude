import uuid


async def test_create_post(client):
    response = await client.post(
        "/api/v1/posts",
        json={"title": "Hello", "content": "World", "author": "tester"},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Hello"
    assert data["content"] == "World"
    assert data["author"] == "tester"
    assert data["view_count"] == 0
    assert data["like_count"] == 0
    assert data["version"] == 1
    assert "id" in data
    assert "created_at" in data
    assert "updated_at" in data


async def test_get_post(client, post):
    assert post["view_count"] == 0

    response = await client.get(f"/api/v1/posts/{post['id']}")
    assert response.status_code == 200
    assert response.json()["view_count"] == 1

    response = await client.get(f"/api/v1/posts/{post['id']}")
    assert response.json()["view_count"] == 2


async def test_get_post_not_found(client):
    fake_id = str(uuid.uuid4())
    response = await client.get(f"/api/v1/posts/{fake_id}")
    assert response.status_code == 404


async def test_list_posts(client):
    for i in range(3):
        await client.post(
            "/api/v1/posts",
            json={"title": f"Post {i}", "content": "Content", "author": "tester"},
        )

    response = await client.get("/api/v1/posts?page=1&size=2")
    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 2
    assert data["total"] == 3
    assert data["page"] == 1
    assert data["size"] == 2

    response = await client.get("/api/v1/posts?page=2&size=2")
    data = response.json()
    assert len(data["items"]) == 1


async def test_update_post(client, post):
    response = await client.put(
        f"/api/v1/posts/{post['id']}",
        json={"title": "Updated", "version": 1},
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Updated"
    assert response.json()["version"] == 2


async def test_update_post_conflict(client, post):
    await client.put(
        f"/api/v1/posts/{post['id']}",
        json={"title": "Updated", "version": 1},
    )

    response = await client.put(
        f"/api/v1/posts/{post['id']}",
        json={"title": "Conflict", "version": 1},
    )
    assert response.status_code == 409

    get_resp = await client.get(f"/api/v1/posts/{post['id']}")
    assert get_resp.json()["title"] == "Updated"


async def test_update_post_not_found(client):
    fake_id = str(uuid.uuid4())
    response = await client.put(
        f"/api/v1/posts/{fake_id}",
        json={"title": "Nope", "version": 1},
    )
    assert response.status_code == 404


async def test_delete_post(client, post):
    response = await client.delete(f"/api/v1/posts/{post['id']}")
    assert response.status_code == 204

    response = await client.get(f"/api/v1/posts/{post['id']}")
    assert response.status_code == 404


async def test_delete_post_not_found(client):
    fake_id = str(uuid.uuid4())
    response = await client.delete(f"/api/v1/posts/{fake_id}")
    assert response.status_code == 404
