# Phase 12: 클라우드 배포 — AWS ECS Fargate + Terraform

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans

**전제:** Phase 11 완료. 로컬에서 모든 기능 + 부하 + 장애 테스트 완료 상태.

**학습 키워드**
`ECS Fargate (Serverless Container)` `Terraform (IaC)` `VPC/Subnet/NAT` `ALB (Application Load Balancer)` `Health Check` `Auto Scaling` `12-Factor App` `Blue/Green Deployment` `IAM Role` `Security Group` `CloudWatch Logs`

---

## 학습: 컨테이너 오케스트레이션

### 핵심 질문 — "인프라를 어떻게 관리했나요?"

> "Terraform으로 IaC를 구성했음. VPC, ECS, RDS, ElastiCache, ALB를 전부 코드로 정의해서 `terraform apply` 한 번에 환경 전체가 올라옴. 중요한 건 인프라가 코드라서 Git으로 변경 이력이 관리되고, 누가 언제 뭘 바꿨는지 추적이 됨. 새 환경을 만들 때도 똑같은 코드 돌리면 됨."

> **"왜 Fargate를 선택했나요?"**

> "$100 예산 제약이 있었는데, EKS는 컨트롤 플레인 자체가 $73/월임. 거기다 워커 노드 EC2까지 추가하면 100달러 훌쩍 넘음. Fargate는 컨테이너 실행 시간만큼만 과금되고 서버 패치나 보안 업데이트를 AWS가 알아서 해줌. 이 프로젝트에서 인프라 관리에 시간 쓰는 것보다 앱 개발에 집중하는 게 맞았음."

---

### IaC(Infrastructure as Code)가 왜 중요한가

콘솔 클릭으로 인프라 구성하는 방식의 문제:

1. **재현 불가능:** "어, 저번에 어떻게 설정했더라?" → 새 환경 만들 때마다 수동 작업 + 실수
2. **감사 불가:** 누가 언제 뭘 바꿨는지 알 수 없음. 보안 사고 후 원인 추적 불가
3. **재해 복구 느림:** 데이터센터 화재 → 새 환경 구성까지 며칠. IaC 있으면 30분

IaC의 장점을 한 문장으로: **인프라를 마치 코드처럼 — 버전 관리되고, 리뷰되고, 테스트되고, 반복 실행 가능하게.**

```bash
# IaC 없이 재해 복구
"서울 리전 설정을 외워서 도쿄에 다시 만들기..." → 며칠 소요

# IaC 있을 때 재해 복구
terraform apply -var="aws_region=ap-northeast-1"  → 30분
```

---

### 왜 Fargate인가 — 구체적인 비용 비교

| 방식 | 월 고정 비용 | 추가 비용 | 운영 부담 |
|------|-----------|---------|---------|
| ECS Fargate | $0 (컨트롤 플레인 없음) | 컨테이너 vCPU/메모리 × 시간 | 거의 없음 |
| EKS | $73 (컨트롤 플레인 고정) | 워커 노드 EC2 비용 | 노드 관리, 업그레이드 |
| EC2 직접 | $0 | EC2 인스턴스 비용 | OS 패치, 보안 업데이트, Docker 설치 |

**이 프로젝트의 실제 계산:**
- EKS 선택 시: $73 (컨트롤 플레인) + $30 (t3.small 워커 2대) + RDS $15 + ElastiCache $13 + ALB $16 = **$147** → 예산 초과
- Fargate 선택 시: $10 (태스크 3개) + RDS $15 + ElastiCache $13 + ALB $16 = **$54** → 예산 내

**EKS가 의미 있는 시점:** 태스크가 수십 개 이상 돌아가서 컨트롤 플레인 $73이 전체의 10% 미만이 될 때. 그 전까지는 Fargate가 훨씬 경제적임.

---

### Immutable Infrastructure — 컨테이너가 바꾼 패러다임

**전통적인 방식 (Mutable):**
```
서버 → SSH 접속 → apt upgrade → 설정 파일 수정 → 재시작
문제: 이 서버는 다른 서버와 미묘하게 다름. "Snowflake Server"
```

**컨테이너 방식 (Immutable):**
```
코드 변경 → Docker 이미지 빌드 → 이미지 푸시 → 기존 컨테이너 교체
특징: 서버를 수정하는 게 아니라 교체함. 모든 환경이 이미지 기준으로 동일
```

이게 왜 중요한가: "내 로컬에서는 됐는데 프로덕션에서 안 됨" 문제가 사라짐. 이미지가 같으면 환경이 같음. Fargate에서 돌리는 컨테이너는 로컬에서 테스트한 것과 동일한 이미지임.

`terraform destroy` 후 `terraform apply`를 다시 실행해도 동일한 인프라가 나오는 것도 같은 원리임.

---

### ECS Fargate vs EKS vs EC2 직접 배포

| | ECS Fargate | EKS (Kubernetes) | EC2 직접 |
|---|---|---|---|
| 서버 관리 | 없음 (서버리스) | 노드 관리 필요 | 전부 직접 |
| 스케일링 | 자동 (태스크 단위) | 자동 (Pod 단위) | 수동 또는 ASG |
| 최소 비용 | ~$15/월 | ~$73/월 (컨트롤 플레인) | ~$8/월 (t3.micro) |
| 학습 곡선 | 낮음 | 매우 높음 | 중간 |
| 운영 복잡도 | 낮음 | 높음 | 중간 |

**ECS Fargate 선택 이유:**
- $100 예산에서 EKS 컨트롤 플레인($73)만으로 예산 초과
- EC2는 서버 패치, 보안 업데이트 직접 해야 함
- Fargate는 사용한 만큼만 과금 + 서버 관리 0

### Terraform — 왜 IaC(Infrastructure as Code)인가

| | Terraform | CloudFormation | Pulumi | CDK |
|---|---|---|---|---|
| 클라우드 | 멀티 | AWS만 | 멀티 | AWS 중심 |
| 언어 | HCL | JSON/YAML | TypeScript/Python | TypeScript/Python |
| 상태 관리 | tfstate 파일 | AWS 관리 | 클라우드 관리 | AWS 관리 |
| 드리프트 감지 | `terraform plan` | 제한적 | 있음 | 제한적 |

**Terraform 선택 이유:**
- 멀티클라우드 경험이 이력서에 강점
- `terraform plan`으로 변경사항 미리 확인 가능 = 실수 방지
- 커뮤니티 모듈이 풍부

---

### $100 예산 내 비용 최적화 전략

| 최적화 포인트 | 설정 | 절감 효과 |
|------------|------|---------|
| NAT Gateway 단일화 | `single_nat_gateway = true` | NAT 2개 → 1개, ~$32 절감 |
| 로그 보존 기간 단축 | `retention_in_days = 7` | CloudWatch Logs 비용 절감 |
| RDS Multi-AZ 비활성 | `multi_az = false` | RDS 비용 절반 |
| Fargate vCPU 최소화 | 0.25 vCPU, 0.5GB | 최소 사양으로 시작 |
| tmp/ 파일 자동 삭제 | S3 Lifecycle 1일 | S3 스토리지 비용 절감 |
| terraform destroy 습관화 | 테스트 후 즉시 삭제 | 방치 시 하루 ~$2 |

**핵심 원칙:** 개발/테스트 환경은 쓸 때만 켜고 끔. 24시간 켜놓으면 월 $56이지만, 하루 2시간씩만 쓰면 월 $4.

### 아키텍처 다이어그램

```
Internet
  │
  ├── ALB (Application Load Balancer)
  │     ├── Target: ECS Service (App × 2 tasks)
  │     └── Health Check: /health
  │
  ├── ECS Fargate
  │     ├── App Task (FastAPI)
  │     ├── Event Consumer Task
  │     └── Counter Sync Task
  │
  ├── RDS PostgreSQL (db.t3.micro)
  │     └── Multi-AZ: 아님 (비용 절감)
  │
  ├── ElastiCache Redis (cache.t3.micro)
  │     └── 클러스터 모드: 아님 (비용 절감)
  │
  └── S3
        ├── tmp/ (Lifecycle: 24시간 자동 삭제)
        └── images/ (영구 보관)
```

### 비용 예측 (월 기준)

| 서비스 | 사양 | 예상 비용 |
|--------|------|----------|
| ECS Fargate | 0.25 vCPU, 0.5GB × 3 tasks | ~$10 |
| RDS PostgreSQL | db.t3.micro | ~$15 |
| ElastiCache Redis | cache.t3.micro | ~$13 |
| ALB | 1개 | ~$16 |
| S3 | 10GB 이하 | ~$1 |
| ECR | 이미지 저장소 | ~$1 |
| **합계** | | **~$56** |

Free Tier 적용 시 더 낮아질 수 있음. $100 예산 내 충분.

### 심화 학습 — 더 깊이 파볼 키워드

| 키워드 | 왜 알아야 하는지 |
|--------|----------------|
| **12-Factor App** | 클라우드 네이티브 앱의 12가지 원칙. 환경변수 설정, 로그 스트림, 프로세스 무상태 등 |
| **Blue/Green Deployment** | 구버전/신버전을 동시에 띄우고 트래픽 전환. 무중단 배포의 핵심 |
| **Terraform State** | tfstate 파일이 현재 인프라 상태를 추적. 원격 백엔드(S3)에 저장해야 팀 협업 가능 |
| **NAT Gateway vs VPC Endpoint** | NAT는 인터넷 경유, VPC Endpoint는 AWS 내부 경유. S3 접근 시 비용 차이 큼 |
| **ECS Task vs Service** | Task = 컨테이너 실행 단위, Service = Task를 관리하는 상위 개념 (desired count, LB 연결) |
| **IAM Role vs User** | EC2/ECS에는 Role 부여 (임시 자격증명), 사람에게는 User (영구 자격증명) |
| **Security Group vs NACL** | SG = 인스턴스 레벨 방화벽 (stateful), NACL = 서브넷 레벨 (stateless) |

---

## 구현

> **TDD 참고:** 이 Phase는 Terraform IaC + 배포. `terraform plan`/`terraform validate`로 검증.

### Task 20: Terraform 인프라 구성

**Files:**
- Create: `infra/main.tf`
- Create: `infra/variables.tf`
- Create: `infra/vpc.tf`
- Create: `infra/ecs.tf`
- Create: `infra/rds.tf`
- Create: `infra/redis.tf`
- Create: `infra/alb.tf`
- Create: `infra/s3.tf`
- Create: `infra/outputs.tf`

- [ ] **Step 1: Terraform 초기 설정 + 변수**

```hcl
# infra/main.tf
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
```

```hcl
# infra/variables.tf
variable "aws_region" {
  default = "ap-northeast-2"  # 서울 리전
}

variable "project_name" {
  default = "extreme-board"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "app_image" {
  description = "ECR 이미지 URI"
  type        = string
}
```

- [ ] **Step 2: VPC 구성**

```hcl
# infra/vpc.tf
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.project_name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.aws_region}a", "${var.aws_region}c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = true  # 비용 절감: NAT 1개만

  tags = {
    Project = var.project_name
  }
}
```

- [ ] **Step 3: RDS PostgreSQL**

```hcl
# infra/rds.tf
resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-subnet"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "rds" {
  name   = "${var.project_name}-rds-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project_name}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t3.micro"

  allocated_storage     = 20
  max_allocated_storage = 50  # 오토스케일링

  db_name  = "extreme_board"
  username = "postgres"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  skip_final_snapshot = true  # 개발용. 프로덕션에서는 false

  tags = {
    Project = var.project_name
  }
}
```

- [ ] **Step 4: ElastiCache Redis**

```hcl
# infra/redis.tf
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project_name}-redis-subnet"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name   = "${var.project_name}-redis-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_elasticache_cluster" "main" {
  cluster_id           = "${var.project_name}-redis"
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  tags = {
    Project = var.project_name
  }
}
```

- [ ] **Step 5: ALB + ECS**

```hcl
# infra/alb.tf
resource "aws_security_group" "alb" {
  name   = "${var.project_name}-alb-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "main" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.public_subnets
}

resource "aws_lb_target_group" "app" {
  name        = "${var.project_name}-tg"
  port        = 8000
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
```

```hcl
# infra/ecs.tf
resource "aws_security_group" "app" {
  name   = "${var.project_name}-app-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project_name}-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"   # 0.25 vCPU
  memory                   = "512"   # 0.5 GB
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([{
    name  = "app"
    image = var.app_image
    portMappings = [{
      containerPort = 8000
      protocol      = "tcp"
    }]
    environment = [
      { name = "DATABASE_URL", value = "postgresql+asyncpg://postgres:${var.db_password}@${aws_db_instance.main.endpoint}/extreme_board" },
      { name = "REDIS_URL", value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:6379" },
      { name = "MINIO_ENDPOINT", value = "" },
      { name = "S3_BUCKET", value = aws_s3_bucket.uploads.id },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/${var.project_name}"
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name            = "${var.project_name}-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 8000
  }
}

# IAM
resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = 7  # 비용 절감
}
```

- [ ] **Step 6: S3 버킷**

```hcl
# infra/s3.tf
resource "aws_s3_bucket" "uploads" {
  bucket = "${var.project_name}-uploads-${random_id.suffix.hex}"
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "cleanup-tmp"
    status = "Enabled"

    filter {
      prefix = "tmp/"
    }

    expiration {
      days = 1  # tmp/ 24시간 후 자동 삭제
    }
  }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

- [ ] **Step 7: Outputs**

```hcl
# infra/outputs.tf
output "alb_dns" {
  value = aws_lb.main.dns_name
}

output "rds_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_cluster.main.cache_nodes[0].address
}

output "s3_bucket" {
  value = aws_s3_bucket.uploads.id
}
```

- [ ] **Step 8: 배포**

```bash
cd infra

# 초기화
terraform init

# 변경사항 확인 (실제 반영 전 미리보기)
terraform plan -var="db_password=YOUR_SECURE_PASSWORD" -var="app_image=YOUR_ECR_URI"

# 반영 (확인 후)
terraform apply -var="db_password=YOUR_SECURE_PASSWORD" -var="app_image=YOUR_ECR_URI"
```

- [ ] **Step 9: 배포 후 확인**

```bash
# ALB DNS로 헬스체크
ALB_DNS=$(terraform output -raw alb_dns)
curl http://$ALB_DNS/health

# 게시글 생성 테스트
curl -X POST http://$ALB_DNS/api/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"Cloud Test","content":"Deployed!","author":"terraform"}'

# k6 부하 테스트 (클라우드 대상)
k6 run -e BASE_URL=http://$ALB_DNS loadtest/scenarios/mixed_load.js
```

- [ ] **Step 10: Commit**

```bash
git add infra/
git commit -m "feat: Terraform AWS infrastructure — ECS Fargate, RDS, ElastiCache, ALB, S3"
```

---

### Task 21: 정리 (비용 초과 방지)

- [ ] **Step 1: 테스트 끝나면 인프라 삭제**

```bash
cd infra
terraform destroy -var="db_password=YOUR_PASSWORD" -var="app_image=YOUR_IMAGE"
```

**중요:** 테스트 후 반드시 `terraform destroy` 실행. 안 하면 매일 ~$2 과금됨.

- [ ] **Step 2: 비용 알림 설정 (선택)**

AWS Billing → Budgets에서 $50 알림 설정 권장. 예산의 절반에서 알림이 오면 대응 가능.

---

## Phase 12 완료 체크리스트

- [ ] Terraform으로 전체 인프라 생성
- [ ] ECS Fargate에서 앱 정상 동작 확인
- [ ] ALB를 통한 외부 접근 확인
- [ ] 클라우드 환경에서 k6 부하 테스트 실행
- [ ] 로컬 vs 클라우드 성능 비교
- [ ] `terraform destroy`로 인프라 정리

**핵심 체감:**
- `terraform plan` → 변경사항 미리 확인. 콘솔 클릭과 차원이 다른 안전성
- 로컬에서 검증한 Docker 이미지가 그대로 클라우드에서 동작 = 컨테이너의 가치
- $100 예산 내에서 프로덕션급 아키텍처 구성 가능
